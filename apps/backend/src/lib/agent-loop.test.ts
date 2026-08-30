import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop, type SandboxDriver } from './agent-loop.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

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

const bodyOf = (model: any, call: number) => JSON.parse(model.mock.calls[call][1].body);

const toolMessageOf = (model: any, call: number) =>
  bodyOf(model, call).messages.find((m: any) => m.role === 'tool');

const sandbox = (over: Partial<SandboxDriver> = {}): SandboxDriver => ({
  exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false })),
  readFile: vi.fn(async () => 'file contents'),
  writeFile: vi.fn(async () => undefined),
  ...over,
});

const run = (fetchImpl: any, box = sandbox(), maxSteps = 6) =>
  runAgentLoop({ budget: BUDGET,
    baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl, maxSteps,
    // The sampler is the pack's now, not a base layer this module composes.
    sampling: PACK_SEEDS[0]!.sampling,
  });

describe('runAgentLoop', () => {
  it('stops when the model calls finish, and reports what it said', async () => {
    const result = await run(scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'Added the test.' })] }]));
    expect(result.succeeded).toBe(true);
    expect(result.summary).toBe('Added the test.');
    expect(result.steps).toBe(1);
  });

  it('treats running out of steps as FAILURE, not completion', async () => {
    let n = 0;
    const model = vi.fn(async () => {
      n += 1;
      return reply({
        content: `Checking the ${['manifest', 'router', 'parser', 'suite', 'lockfile'][n % 5]} now`,
        tool_calls: [toolCall('run_command', { command: `cat file${n}.js` })],
      }) as any;
    });
    const result = await run(model, sandbox(), 4);
    expect(result.succeeded).toBe(false);
    expect(result.summary).toMatch(/Ran out of steps \(4\)/);
    expect(result.outOfBudget).toBe(true);
    expect(model).toHaveBeenCalledTimes(5);
  });

  it('nudges a model that answers in prose, then gives up rather than looping', async () => {
    const model = scriptedModel([{ content: 'I would start by reading the file.' }]);
    const result = await run(model, sandbox(), 3);
    expect(result.succeeded).toBe(false);
    expect(model).toHaveBeenCalledTimes(3);
  });

  it('honours a finish that reports failure, instead of retrying inside the loop', async () => {
    const result = await run(scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: false, summary: 'No package.json anywhere.' })] }]));
    expect(result.succeeded).toBe(false);
    expect(result.summary).toBe('No package.json anywhere.');
  });

  it('feeds a failing command back to the model instead of aborting the attempt', async () => {
    const box = sandbox({ exec: vi.fn(async () => ({ stdout: '', stderr: 'tsc: error', exitCode: 2, timedOut: false })) });
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'npm run build' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'Fixed it.' })] },
    ]);
    const result = await run(model, box);
    expect(result.succeeded).toBe(true);
    const toolMessage = toolMessageOf(model, 1);
    expect(toolMessage.content).toContain('tsc: error');
    expect(toolMessage.content).toContain('"exitCode":2');
  });

  it('reports a thrown sandbox error to the model rather than losing the work done so far', async () => {
    const box = sandbox({ readFile: vi.fn(async () => { throw new Error('Path escapes the workspace'); }) });
    const model = scriptedModel([
      { tool_calls: [toolCall('read_file', { path: '../../etc/passwd' })] },
      { tool_calls: [toolCall('finish', { succeeded: false, summary: 'Blocked.' })] },
    ]);
    const result = await run(model, box);
    expect(result.summary).toBe('Blocked.');
    const toolMessage = toolMessageOf(model, 1);
    expect(toolMessage.content).toContain('escapes the workspace');
  });

  it('reassembles tool-call arguments split across stream frames', async () => {
    const box = sandbox();
    const model = scriptedModel([
      { tool_calls: [toolCall('write_file', { path: 'src/a.ts', content: 'export const x = 1;' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] },
    ]);
    await run(model, box);
    expect(box.writeFile).toHaveBeenCalledWith('src/a.ts', 'export const x = 1;');
  });

  it('counts tokens from the usage frame, which only a streamed response carries', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'x' })] }]);
    expect((await run(model)).tokensUsed).toBe(10);
    expect(bodyOf(model, 0).stream_options).toEqual({ include_usage: true });
  });

  it('sums tokens across every call, including the ones that failed', async () => {
    let i = 0;
    const model = vi.fn(async () =>
      (i++ === 0
        ? reply({ tool_calls: [toolCall('run_command', { command: 'ls' })] }, 100)
        : reply({ tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] }, 250)) as any);
    expect((await run(model)).tokensUsed).toBe(350);
  });

  it('records what it ran, so a failure can be diagnosed without the model transcript', async () => {
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'npm test' })] },
      { tool_calls: [toolCall('write_file', { path: 'a.ts', content: 'x' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] },
    ]);
    expect((await run(model)).transcript).toEqual(['npm test', 'write a.ts', 'finish: succeeded=true summary=ok']);
  });

  it('throws when the model endpoint itself is broken, so it is not mistaken for a task failure', async () => {
    const model = vi.fn(async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }) as any);
    await expect(run(model)).rejects.toThrow(/502/);
  });

  it('tells the model the command was killed, so a timeout is not read as empty output', async () => {
    const box = sandbox({ exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: -1, timedOut: true })) });
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'sleep 999' })] },
      { tool_calls: [toolCall('finish', { succeeded: false, summary: 'timed out' })] },
    ]);
    await run(model, box);
    const toolMessage = toolMessageOf(model, 1);
    expect(toolMessage.content).toContain('timedOut');
  });

  it('sends an overridden temperature, so an experiment varying it actually varies something', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { temperature: 0.9 },
    });
    expect(bodyOf(model, 0).temperature).toBe(0.9);
  });

  it('reads loop-placement overrides instead of sending them', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { maxSteps: 3 },
    });
    expect(model).toHaveBeenCalledTimes(4);
    expect(result.summary).toMatch(/Ran out of steps \(3\)/);
    expect(bodyOf(model, 0).maxSteps).toBeUndefined();
  });

  it('appends extra instructions while keeping the generated environment description', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { extraInstructions: 'Prefer small commits.' },
    });
    const system = bodyOf(model, 0).messages[0].content;
    expect(system).toMatch(/Prefer small commits\./);
    expect(system).toMatch(/NO outbound network/);
  });

  it('replaces the whole system prompt but never the task', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { systemPrompt: 'You are terse.' },
    });
    const system = bodyOf(model, 0).messages[0].content;
    expect(system).toContain('You are terse.');
    expect(system).toContain('Do the thing');
    expect(system).not.toMatch(/NO outbound network/);
  });

  it('reports a knob it could not send rather than pretending the variant differed', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      kind: 'vllm', overrides: { dry_multiplier: 0.8 },
    });
    expect(result.unsupported).toEqual(['dry_multiplier']);
  });

  it('samples at what the pack says when no temperature is given', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await run(model);
    expect(bodyOf(model, 0).temperature).toBe(0.3);
  });

  it('caps tool-call arguments in the trace, keeping the head where the path is', async () => {
    const big = 'x'.repeat(20_000);
    const model = scriptedModel([
      { tool_calls: [toolCall('write_file', { path: 'src/index.ts', content: big })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] },
    ]);
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      captureTrace: true,
    });
    const args = result.trace![0]!.toolCalls[0]!.arguments;
    expect(args.length).toBeLessThan(3000);
    expect(args).toContain('src/index.ts');
    expect(result.trace![0]!.truncated).toBe(true);
  });
});

describe('the step budget the agent can see', () => {
  const runner = (maxSteps: number) => {
    const model = scriptedModel([{ tool_calls: [toolCall('exec', { command: 'ls' })] }]);
    return { model, done: run(model, sandbox(), maxSteps) };
  };

  it('says nothing while there is plenty left', async () => {
    const { model, done } = runner(10);
    await done;

    expect(toolMessageOf(model, 1).content).not.toMatch(/steps? left/i);
  });

  it('warns near the end, and says what to do about it', async () => {
    const { model, done } = runner(4);
    const result = await done;

    const warned = model.mock.calls
      .map((c: any) => JSON.parse(c[1].body).messages.filter((m: any) => m.role === 'tool'))
      .flat()
      .filter((m: any) => /steps? left/i.test(m.content));

    expect(warned.length).toBeGreaterThan(0);
    expect(warned[0].content).toMatch(/commit and push/i);
    expect(result.succeeded).toBe(false);
  });

  it('attaches the warning to a tool result rather than spending a step on it', async () => {
    const { model, done } = runner(4);
    await done;

    const bodies = model.mock.calls.map((c: any) => JSON.parse(c[1].body));
    const extraUserTurns = bodies[bodies.length - 1].messages
      .filter((m: any) => m.role === 'user' && /steps? left/i.test(m.content ?? ''));
    expect(extraUserTurns).toEqual([]);
  });
});

describe('the stored conversation', () => {
  it('is the array the request was built from, not a reconstruction', async () => {
    const box = sandbox({
      exec: vi.fn(async () => ({ stdout: 'X'.repeat(3000), stderr: '', exitCode: 0, timedOut: false })),
    });
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'ls' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] },
    ]);
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl: model,
      captureTrace: true,
    });

    const convo = result.conversation!;
    expect(convo.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(convo[0]!.content).toMatch(/NO outbound network/);
    expect(convo[1]!.content).toMatch(/^Begin\./);
    expect(convo[2]!.toolCalls?.[0]?.name).toBe('run_command');
    const toolMessage = convo[3]!;
    expect(toolMessage.toolCallId).toBe('c1');
    expect(toolMessage.content.length).toBeGreaterThan(1200);
    expect(result.trace![0]!.toolResults[0]!.result.length).toBeLessThanOrEqual(1300);
  });

  it('is absent when the run is not being recorded', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    expect((await run(model)).conversation).toBeUndefined();
  });

  it('marks a message it had to shorten, so it never reads as complete', async () => {
    const box = sandbox({
      exec: vi.fn(async () => ({ stdout: 'Y'.repeat(20_000), stderr: '', exitCode: 0, timedOut: false })),
    });
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'ls' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] },
    ]);
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do it', sandbox: box, fetchImpl: model, captureTrace: true,
    });
    expect(result.conversation!.find((m) => m.role === 'tool')!.truncated).toBe(true);
  });
});

describe('running out of budget is a stop, not a verdict', () => {

  const neverFinishes = (wrapUp: Record<string, unknown>) => {
    let calls = 0;
    return vi.fn(async (_url: string, init: any) => {
      calls += 1;
      const body = JSON.parse(init.body);
      const only = body.tools?.length === 1 && body.tools[0].function?.name === 'finish';
      if (only) return reply(wrapUp) as any;
      return reply({ tool_calls: [toolCall('run_command', { command: `echo ${calls}` })] }) as any;
    });
  };

  it('asks the agent to account for itself before calling the run a failure', async () => {
    const model = neverFinishes({
      tool_calls: [toolCall('finish', {
        succeeded: true,
        summary: 'Wrote and committed test/github-client.test.js; pushed to koala/7565dc49. 30 tests pass.',
      })],
    });
    const out = await run(model, sandbox(), 3);

    expect(out.succeeded).toBe(true);
    expect(out.summary).toContain('koala/7565dc49');
    expect(out.outOfBudget).toBe(true);
  });

  it('offers only `finish` on that turn, so it cannot just keep working', async () => {
    const model = neverFinishes({ tool_calls: [toolCall('finish', { succeeded: false, summary: 'Got nowhere.' })] });
    await run(model, sandbox(), 3);

    const last = JSON.parse(model.mock.calls[model.mock.calls.length - 1]![1].body);
    expect(last.tools).toHaveLength(1);
    expect(last.tools[0].function.name).toBe('finish');
    expect(JSON.stringify(last.messages)).toMatch(/call `finish` now/i);
  });

  it('believes an honest failure too', async () => {
    const model = neverFinishes({
      tool_calls: [toolCall('finish', { succeeded: false, summary: 'Could not reach the registry.' })],
    });
    const out = await run(model, sandbox(), 3);
    expect(out.succeeded).toBe(false);
    expect(out.summary).toContain('registry');
  });

  it('keeps BOTH the diagnosis and the prose account', async () => {
    const model = neverFinishes({ content: 'I already committed the tests and pushed them.' });
    const out = await run(model, sandbox(), 3);
    expect(out.summary).toMatch(/Ran out of steps \(3\)/);
    expect(out.summary).toContain('already committed the tests');
  });

  it('keeps prose when the agent answers without calling the tool', async () => {
    const model = neverFinishes({ content: 'I already committed the tests and pushed them.' });
    const out = await run(model, sandbox(), 3);
    expect(out.summary).toContain('already committed the tests');
    expect(out.succeeded).toBe(false);
  });

  it('still reports the run when the wrap-up call itself fails', async () => {
    let calls = 0;
    const model = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.tools?.length === 1) throw new Error('model unreachable');
      calls += 1;
      return reply({ tool_calls: [toolCall('run_command', { command: `echo ${calls}` })] }) as any;
    });
    const out = await run(model, sandbox(), 3);
    expect(out.succeeded).toBe(false);
    expect(out.summary).toMatch(/Ran out of steps/);
    expect(out.outOfBudget).toBe(true);
  });
});

describe('bounding by what actually costs', () => {
  it('stops on spend, and says so in those terms', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);
    const out = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      maxSteps: 100, maxTokens: 25,
    });
    expect(out.succeeded).toBe(false);
    expect(out.summary).toMatch(/Ran out of tokens/);
    expect(out.summary).not.toMatch(/Ran out of steps/);
    expect(out.outOfBudget).toBe(true);
  });

  it('never cuts a turn in half to enforce the budget', async () => {
    const box = sandbox();
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl: model,
      maxSteps: 100, maxTokens: 25,
    });
    const asked = model.mock.calls.length;
    expect((box.exec as any).mock.calls.length).toBeGreaterThan(0);
    expect(asked).toBeGreaterThan(1);
  });

  it('lets a run finish normally well inside a generous budget', async () => {
    const out = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'Done.' })] }]),
      maxTokens: 1_000_000,
    });
    expect(out.succeeded).toBe(true);
    expect(out.outOfBudget).toBeUndefined();
  });
});

describe('stopping a run that is going in circles', () => {
  it('stops a busy loop and says what repeated', async () => {
    const model = scriptedModel([{
      content: 'Rewrite the server to fix the port binding',
      tool_calls: [toolCall('write_file', { path: 'src/server.js', content: 'x' })],
    }]);
    const out = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      maxSteps: 40,
    });

    expect(out.succeeded).toBe(false);
    expect(out.summary).toMatch(/loop, not progress/i);
    expect(out.summary).toMatch(/port binding/);
    expect(out.steps).toBeLessThan(10);
  });

  it('does not offer a wrap-up turn for circling', async () => {
    const model = scriptedModel([{
      content: 'Rewrite the server to fix the port binding',
      tool_calls: [toolCall('write_file', { path: 'src/server.js', content: 'x' })],
    }]);
    const out = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model, maxSteps: 40,
    });
    const last = JSON.parse((model.mock.calls as any[])[model.mock.calls.length - 1][1].body);
    expect(last.tools.length).toBeGreaterThan(1);
    expect(out.outOfBudget).toBeUndefined();
  });

  it('lets a run that varies its work reach the end', async () => {
    let n = 0;
    const model = vi.fn(async () => {
      n += 1;
      if (n > 4) return reply({ tool_calls: [toolCall('finish', { succeeded: true, summary: 'Done.' })] }) as any;
      return reply({
        content: `Step ${n}: ${['read the manifest', 'add the parser module', 'wire up the router', 'write the integration test'][n - 1]}`,
        tool_calls: [toolCall('write_file', { path: `src/file${n}.js`, content: `${n}` })],
      }) as any;
    });
    const out = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model, maxSteps: 40,
    });
    expect(out.succeeded).toBe(true);
    expect(out.summary).toBe('Done.');
  });
});

describe('tools from the servers this harness built', () => {
  const remoteTool = (name: string) => ({
    type: 'function' as const,
    function: { name, description: `[weather] ${name}`, parameters: { type: 'object', properties: {} } },
  });

  it('offers them alongside the built-ins', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      remoteTools: [remoteTool('weather__get-forecast')],
    });
    const names = bodyOf(model, 0).tools.map((t: any) => t.function.name);
    expect(names).toContain('weather__get-forecast');
    expect(names).toContain('run_command');
  });

  it('routes a remote call to the remote handler, not the sandbox', async () => {
    const box = sandbox();
    const callRemote = vi.fn(async (name: string) =>
      name === 'weather__get-forecast' ? { text: '{"tempC":18}', isError: false } : undefined);
    const model = scriptedModel([{ tool_calls: [toolCall('weather__get-forecast', { city: 'London' })] }]);

    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl: model,
      maxSteps: 2, remoteTools: [remoteTool('weather__get-forecast')], callRemote,
    });

    expect(callRemote).toHaveBeenCalledWith('weather__get-forecast', { city: 'London' });
    expect((box.exec as any).mock.calls).toHaveLength(0);
    expect(JSON.stringify(bodyOf(model, 1).messages)).toContain('tempC');
  });

  it('NEVER lets a remote handler shadow a built-in', async () => {
    const box = sandbox();
    const callRemote = vi.fn(async () => ({ text: 'HIJACKED', isError: false }));
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);

    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl: model,
      maxSteps: 2, callRemote,
    });

    expect((box.exec as any).mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(bodyOf(model, 1).messages)).not.toContain('HIJACKED');
  });

  it('does not let a remote tool replace a built-in in the offer either', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'x' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      remoteTools: [remoteTool('run_command')],
    });
    const commands = bodyOf(model, 0).tools.filter((t: any) => t.function.name === 'run_command');
    expect(commands).toHaveLength(1);
    expect(commands[0].function.description).not.toContain('[weather]');
  });

  it('reports a failing remote tool to the model instead of ending the run', async () => {
    const callRemote = vi.fn(async () => ({ text: 'city not found', isError: true }));
    const model = scriptedModel([{ tool_calls: [toolCall('weather__get-forecast', { city: 'zzz' })] }]);
    const out = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      maxSteps: 2, remoteTools: [remoteTool('weather__get-forecast')], callRemote,
    });
    expect(JSON.stringify(bodyOf(model, 1).messages)).toContain('city not found');
    expect(out.succeeded).toBe(false);
  });

  it('respects a persona that named its tools', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'x' })] }]);
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      allowTools: ['run_command', 'finish'], remoteTools: [remoteTool('weather__get-forecast')],
    });
    const names = bodyOf(model, 0).tools.map((t: any) => t.function.name);
    expect(names).not.toContain('weather__get-forecast');
  });
});

describe('checkpointing a run', () => {
  const withCheckpoint = (fetchImpl: any, checkpoint: any, maxTokens = 30) =>
    runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Add a rate limiter', sandbox: sandbox(),
      fetchImpl, maxSteps: 8, maxTokens, checkpoint,
    });

  const working = () => scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);

  it('saves, and records where the save landed', async () => {
    const checkpoint = vi.fn(async () => ({ artifact: '# Checkpoint 1\nsaved state', sha: 'abc1234', branch: 'koala/aaa' }));

    const result = await withCheckpoint(working(), checkpoint);

    expect(checkpoint).toHaveBeenCalled();
    expect(result.checkpoints?.[0]).toMatchObject({ sha: 'abc1234', branch: 'koala/aaa' });
  });

  it('asks the agent for a handoff with exactly one tool on offer', async () => {
    const model = working();
    await withCheckpoint(model, vi.fn(async () => ({ artifact: 'a' })));

    const handoffCall = model.mock.calls
      .map((c: any) => JSON.parse(c[1].body))
      .find((b: any) => b.tools?.length === 1 && b.tools[0].function?.name === 'handoff');

    expect(handoffCall).toBeDefined();
    expect(handoffCall.tools).toHaveLength(1);
  });

  it('passes the agent’s handoff through to whatever writes the artifact', async () => {
    const checkpoint = vi.fn(async () => ({ artifact: 'a' }));
    const model = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.tools?.length === 1 && body.tools[0].function?.name === 'handoff') {
        return reply({ tool_calls: [toolCall('handoff', { done: 'bucket written', next: 'wire middleware' })] }) as any;
      }
      return reply({ tool_calls: [toolCall('run_command', { command: 'ls' })] }) as any;
    });

    await withCheckpoint(model, checkpoint);

    expect((checkpoint.mock.calls[0] as any)[0]).toMatchObject({
      number: 1,
      handoff: { done: 'bucket written', next: 'wire middleware' },
    });
  });

  it('replaces the conversation with the artifact', async () => {
    const model = working();
    await withCheckpoint(model, vi.fn(async () => ({ artifact: '# Checkpoint 1\nTHE SAVED STATE' })));

    const after = model.mock.calls
      .map((c: any) => JSON.parse(c[1].body))
      .filter((b: any) => !(b.tools?.length === 1 && b.tools[0].function?.name === 'handoff'))
      .find((b: any) => JSON.stringify(b.messages).includes('THE SAVED STATE'));

    expect(after).toBeDefined();
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0].role).toBe('system');
    expect(after.messages[1].content).toContain('THE SAVED STATE');
    expect(after.messages[1].content).toContain('was reset');
  });

  it('does NOT reset when the save failed', async () => {
    const model = working();
    const result = await withCheckpoint(model, vi.fn(async () => undefined));

    expect(result.checkpoints).toBeUndefined();
    expect(result.steps).toBeGreaterThan(0);
  });

  it('survives a driver that throws', async () => {
    const model = working();
    const result = await withCheckpoint(model, vi.fn(async () => { throw new Error('gitea exploded'); }));

    expect(result.checkpoints).toBeUndefined();
    expect(result.summary).toBeTruthy();
  });

  it('does not checkpoint at all when the caller cannot save', async () => {
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: working(), maxSteps: 4, maxTokens: 30,
    });
    expect(result.checkpoints).toBeUndefined();
  });
});

describe('earning more room', () => {
  const working = () => scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);

  const withBudget = (fetchImpl: any, extendBudget: any, maxSteps = 3) =>
    runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Add a rate limiter', sandbox: sandbox(),
      fetchImpl, maxSteps, extendBudget,
    });

  it('carries on when the run has earned it', async () => {
    const extend = vi.fn(async () => ({ steps: 3, reason: 'granted because its tests now pass' }));
    const result = await withBudget(working(), extend);

    expect(extend).toHaveBeenCalled();
    expect(result.steps).toBeGreaterThan(3);
    expect(result.extensions?.[0]?.reason).toContain('its tests now pass');
  });

  it('stops at the ceiling when nothing earned it', async () => {
    const result = await withBudget(working(), vi.fn(async () => undefined));
    expect(result.steps).toBe(3);
    expect(result.extensions).toBeUndefined();
  });

  it('hands the loop’s own diagnoses to whoever decides', async () => {
    const extend = vi.fn(async () => undefined);
    await withBudget(working(), extend);

    expect((extend.mock.calls[0] as any)[0]).toMatchObject({
      exhausted: 'steps',
      extensionsUsed: 0,
      thrashing: expect.any(Boolean),
      circling: expect.any(Boolean),
      silent: expect.any(Boolean),
    });
  });

  it('tells the agent its budget moved', async () => {
    const model = working();
    await withBudget(model, vi.fn(async () => ({ steps: 3, reason: 'granted because its tests now pass' })));

    const sawNotice = model.mock.calls
      .map((c: any) => JSON.parse(c[1].body))
      .some((b: any) => JSON.stringify(b.messages).includes('Ignore any earlier statement of your budget'));

    expect(sawNotice).toBe(true);
  });

  it('counts each grant, so the decider can eventually stop granting', async () => {
    const extend = vi.fn(async () => ({ steps: 2, reason: 'granted because 2 new commits' }));
    const result = await withBudget(working(), extend, 2);

    expect((extend.mock.calls[0] as any)[0].extensionsUsed).toBe(0);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions?.[0]).toMatchObject({ at: 'steps', steps: 2 });
  });

  it('still stops a circling run, extension or not', async () => {
    const result = await withBudget(working(), vi.fn(async () => ({ steps: 2, reason: 'granted' })), 2);

    expect(result.succeeded).toBe(false);
    expect(result.summary).toMatch(/repeat|loop|no meaningful variation/i);
    expect(result.extensions).toHaveLength(1);
  });

  it('survives a decider that throws', async () => {
    const result = await withBudget(working(), vi.fn(async () => { throw new Error('mongo gone'); }));
    expect(result.steps).toBe(3);
    expect(result.summary).toBeTruthy();
  });

  it('does not extend at all when the caller cannot', async () => {
    const result = await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: working(), maxSteps: 3,
    });
    expect(result.steps).toBe(3);
    expect(result.extensions).toBeUndefined();
  });
});

describe('saving a lesson', () => {
  const asking = () => scriptedModel([
    { tool_calls: [toolCall('save_harness_memory', { category: 'lessons_learned', title: 'npm ci needs a lockfile', text: 'The build context has no package-lock.json.' })] },
  ]);

  it('actually writes it', async () => {
    const saveMemory = vi.fn(async () => ({ action: 'ADD' }));
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: asking(), maxSteps: 2, saveMemory,
    });

    expect(saveMemory).toHaveBeenCalled();
    expect((saveMemory.mock.calls[0] as any)[0]).toMatchObject({
      category: 'lessons_learned',
      title: 'npm ci needs a lockfile',
      suggestedScope: 'project',
    });
  });

  it('tells the agent it is stored, now that it actually is', async () => {
    const model = asking();
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: model, maxSteps: 2, saveMemory: vi.fn(async () => ({ action: 'ADD' })),
    });

    const result = toolMessageOf(model, 1);
    expect(result.content).toContain('"saved":true');
    expect(result.content).toContain('available to future runs');
  });

  it('says so when the bank already held it, rather than claiming a write', async () => {
    const model = asking();
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: model, maxSteps: 2, saveMemory: vi.fn(async () => ({ action: 'NOOP' })),
    });

    const result = toolMessageOf(model, 1).content;
    expect(result).toContain('"saved":false');
    expect(result).toContain('already holds this');
  });

  it('says it could not save rather than claiming it did', async () => {
    const model = asking();
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: model, maxSteps: 2,
    });

    const result = toolMessageOf(model, 1).content;
    expect(result).toContain('"saved":false');
    expect(result).toMatch(/nothing is listening/);
  });

  it('reports a write that failed, instead of swallowing it', async () => {
    const model = asking();
    await runAgentLoop({ budget: BUDGET,
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(),
      fetchImpl: model, maxSteps: 2,
      saveMemory: vi.fn(async () => { throw new Error('mongo is down'); }),
    });

    const result = toolMessageOf(model, 1).content;
    expect(result).toContain('"saved":false');
    expect(result).toMatch(/mongo is down/);
  });
});
