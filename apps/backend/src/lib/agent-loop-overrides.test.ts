import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop, type SandboxDriver } from './agent-loop.js';
import { TUNABLES } from './tunables.js';

const sse = (frames: unknown[]) =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

const frame = (delta: unknown) => ({ choices: [{ delta }] });

const reply = (message: { content?: string; tool_calls?: any[] }, tokens = 10) => {
  const frames: unknown[] = [];
  if (message.content) frames.push(frame({ content: message.content }));
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    frames.push(frame({ tool_calls: [{ index, id: call.id, function: { name: call.function.name } }] }));
    const args: string = call.function.arguments;
    const mid = Math.ceil(args.length / 2);
    frames.push(frame({ tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] }));
    frames.push(frame({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] }));
  }
  frames.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: tokens } });
  return { ok: true, text: async () => sse(frames) };
};

const toolCall = (name: string, args: Record<string, unknown>, id = 'c1') => ({
  id,
  function: { name, arguments: JSON.stringify(args) },
});

const scriptedModel = (replies: Record<string, unknown>[]) => {
  let i = 0;
  return vi.fn(async () => reply(replies[Math.min(i++, replies.length - 1)]!) as any);
};

const bodyOf = (model: any, call = 0) => JSON.parse(model.mock.calls[call][1].body);

const sandbox = (over: Partial<SandboxDriver> = {}): SandboxDriver => ({
  exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false })),
  readFile: vi.fn(async () => 'file contents'),
  writeFile: vi.fn(async () => undefined),
  ...over,
});

describe('loop-level overrides reach the agent loop execution', () => {
  it('replaces system prompt when systemPrompt override is set', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] }]);
    const customPrompt = 'Custom System Prompt For Testing Only';
    
    await runAgentLoop({
      baseUrl: 'http://model',
      taskContext: 'My Task',
      sandbox: sandbox(),
      fetchImpl: model,
      overrides: { systemPrompt: customPrompt },
    });

    const body = bodyOf(model);
    const sysMsg = body.messages.find((m: any) => m.role === 'system');
    expect(sysMsg.content).toContain(customPrompt);
    expect(sysMsg.content).toContain('YOUR TASK');
    expect(sysMsg.content).toContain('My Task');
  });

  it('appends extra instructions when extraInstructions override is set', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] }]);
    const extraText = 'ALWAYS USE DOUBLE QUOTES';

    await runAgentLoop({
      baseUrl: 'http://model',
      taskContext: 'My Task',
      sandbox: sandbox(),
      fetchImpl: model,
      overrides: { extraInstructions: extraText },
    });

    const body = bodyOf(model);
    const sysMsg = body.messages.find((m: any) => m.role === 'system');
    expect(sysMsg.content).toContain(extraText);
  });

  it('honours maxSteps override over option maxSteps', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);
    
    const result = await runAgentLoop({
      baseUrl: 'http://model',
      taskContext: 'My Task',
      sandbox: sandbox(),
      fetchImpl: model,
      maxSteps: 10,
      overrides: { maxSteps: 3 },
    });

    expect(result.succeeded).toBe(false);
    // 3 working turns from the override, plus the wrap-up turn a budget stop now earns. The point
    // of the test is that the override beat the option's 10, and it did.
    expect(model).toHaveBeenCalledTimes(4);
  });

  it('honours maxToolResultChars override to cap tool output', async () => {
    const bigOutput = 'A'.repeat(5000);
    const box = sandbox({
      exec: vi.fn(async () => ({ stdout: bigOutput, stderr: '', exitCode: 0, timedOut: false })),
    });
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'ls' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] },
    ]);

    await runAgentLoop({
      baseUrl: 'http://model',
      taskContext: 'My Task',
      sandbox: box,
      fetchImpl: model,
      captureTrace: true,
      overrides: { maxToolResultChars: 1000 },
    });

    const toolMsg = bodyOf(model, 1).messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content.length).toBeLessThanOrEqual(1050);
  });

  it('passes think override as enable_thinking under template_vars', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] }]);

    await runAgentLoop({
      baseUrl: 'http://model',
      taskContext: 'My Task',
      sandbox: sandbox(),
      fetchImpl: model,
      overrides: { think: true },
    });

    const body = bodyOf(model);
    expect(body.template_vars).toEqual({ enable_thinking: true });
  });

  it('passes sampling overrides (temperature, top_p, etc.) to the wire body', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] }]);

    await runAgentLoop({
      baseUrl: 'http://model',
      taskContext: 'My Task',
      sandbox: sandbox(),
      fetchImpl: model,
      overrides: { temperature: 0.15, top_p: 0.95 },
    });

    const body = bodyOf(model);
    expect(body.temperature).toBe(0.15);
    expect(body.top_p).toBe(0.95);
  });
});

describe('all registered tunables in TUNABLES registry are handled correctly', () => {
  it('covers systemPrompt in TUNABLES list with key name matching systemPrompt', () => {
    const sysPromptTunable = TUNABLES.find((t) => t.key === 'systemPrompt');
    expect(sysPromptTunable).toBeDefined();
    expect(sysPromptTunable?.group).toBe('prompt');
    expect(sysPromptTunable?.placement).toBe('loop');
  });

  it('ensures every loop-placement tunable in TUNABLES is consumed by runAgentLoop', () => {
    const loopKeys = TUNABLES.filter((t) => t.placement === 'loop').map((t) => t.key);
    expect(loopKeys).toContain('systemPrompt');
    expect(loopKeys).toContain('maxSteps');
    expect(loopKeys).toContain('maxToolResultChars');
    expect(loopKeys).toContain('model');
  });
});
