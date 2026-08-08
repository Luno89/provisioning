import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop, type SandboxDriver } from './agent-loop.js';

/**
 * These are termination tests.
 *
 * A loop driven by model output has three ways to never end — tools forever, prose forever, or a
 * `finish` that does not finish — and none of them show up as an error. They show up as a leaf
 * stuck "running" while tokens drain, which is why the fake model here is scripted rather than
 * live: the interesting cases are the ones a cooperative model never produces.
 */
/**
 * Builds a real SSE stream, because the loop consumes one.
 *
 * Deliberately fragments the tool-call arguments across frames — that is how the endpoint actually
 * emits them, and reading only the first frame yields a call with empty arguments that then runs
 * with defaults.
 */
const sse = (frames: unknown[]) =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

const frame = (delta: unknown) => ({ choices: [{ delta }] });

const reply = (message: { content?: string; tool_calls?: any[] }, tokens = 10) => {
  const frames: unknown[] = [];
  if (message.content) frames.push(frame({ content: message.content }));
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    // Name first, then arguments split in two — the real fragmentation shape.
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

/** A model that returns a scripted sequence, then repeats its last reply forever. */
const scriptedModel = (replies: Record<string, unknown>[]) => {
  let i = 0;
  return vi.fn(async () => reply(replies[Math.min(i++, replies.length - 1)]!) as any);
};

/** The request body of the nth model call. Typed loosely because vi.fn's inferred arg tuple is
 *  empty, and every assertion here is about JSON we sent, not about the mock's shape. */
const bodyOf = (model: any, call: number) => JSON.parse(model.mock.calls[call][1].body);

/** The tool result the model was shown on its nth call. */
const toolMessageOf = (model: any, call: number) =>
  bodyOf(model, call).messages.find((m: any) => m.role === 'tool');

const sandbox = (over: Partial<SandboxDriver> = {}): SandboxDriver => ({
  exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false })),
  readFile: vi.fn(async () => 'file contents'),
  writeFile: vi.fn(async () => undefined),
  ...over,
});

const run = (fetchImpl: any, box = sandbox(), maxSteps = 6) =>
  runAgentLoop({ baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl, maxSteps });

describe('runAgentLoop', () => {
  it('stops when the model calls finish, and reports what it said', async () => {
    const result = await run(scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'Added the test.' })] }]));
    expect(result.succeeded).toBe(true);
    expect(result.summary).toBe('Added the test.');
    expect(result.steps).toBe(1);
  });

  it('treats running out of steps as FAILURE, not completion', async () => {
    // The dangerous case: a model that keeps working forever. Reporting "ran 24 commands" as
    // success would mark unfinished work complete and move it to review.
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);
    const result = await run(model, sandbox(), 4);
    expect(result.succeeded).toBe(false);
    expect(result.summary).toMatch(/Ran out of steps \(4\)/);
    expect(model).toHaveBeenCalledTimes(4);
  });

  it('nudges a model that answers in prose, then gives up rather than looping', async () => {
    const model = scriptedModel([{ content: 'I would start by reading the file.' }]);
    const result = await run(model, sandbox(), 3);
    expect(result.succeeded).toBe(false);
    expect(model).toHaveBeenCalledTimes(3);
  });

  it('honours a finish that reports failure, instead of retrying inside the loop', async () => {
    // "I am stuck" must end the attempt. The retry policy lives outside, and only there does the
    // next attempt get the failure written into its context.
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
    // The exit code and stderr must reach the model — that is the whole feedback loop.
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
    // The failure this prevents is silent: a call whose arguments never arrived runs with defaults
    // and looks like the model asked for something it did not.
    const box = sandbox();
    const model = scriptedModel([
      { tool_calls: [toolCall('write_file', { path: 'src/a.ts', content: 'export const x = 1;' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'done' })] },
    ]);
    await run(model, box);
    expect(box.writeFile).toHaveBeenCalledWith('src/a.ts', 'export const x = 1;');
  });

  it('counts tokens from the usage frame, which only a streamed response carries', async () => {
    // Measured against the live endpoint: a non-streamed response returns `usage: null`, so a
    // non-streaming loop meters every attempt at zero and the root budget never trips.
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
    // A 500 from the endpoint is infrastructure, and must reach Temporal's retry — not be recorded
    // as "the agent could not do the task".
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
    // Without this the Lab's temperature axis expanded into variants that were byte-for-byte the
    // same request, and the noise between two identical configurations was reported as an effect.
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { temperature: 0.9 },
    });
    expect(bodyOf(model, 0).temperature).toBe(0.9);
  });

  it('reads loop-placement overrides instead of sending them', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('run_command', { command: 'ls' })] }]);
    const result = await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { maxSteps: 3 },
    });
    expect(model).toHaveBeenCalledTimes(3);
    expect(result.summary).toMatch(/Ran out of steps \(3\)/);
    expect(bodyOf(model, 0).maxSteps).toBeUndefined();
  });

  it('appends extra instructions while keeping the generated environment description', async () => {
    // The safe way to test wording: a full replacement drops the "there is no network" text and
    // the agent plans around an npm install that cannot work.
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { extraInstructions: 'Prefer small commits.' },
    });
    const system = bodyOf(model, 0).messages[0].content;
    expect(system).toMatch(/Prefer small commits\./);
    expect(system).toMatch(/NO outbound network/);
  });

  it('replaces the whole system prompt but never the task', async () => {
    // Dropping taskContext would produce an agent asked to do nothing — a variant that cannot
    // succeed, reading as evidence that the new wording was worse.
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      overrides: { systemPrompt: 'You are terse.' },
    });
    const system = bodyOf(model, 0).messages[0].content;
    expect(system).toContain('You are terse.');
    expect(system).toContain('Do the thing');
    // The generated environment description is what a replacement trades away.
    expect(system).not.toMatch(/NO outbound network/);
  });

  it('reports a knob it could not send rather than pretending the variant differed', async () => {
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    const result = await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: sandbox(), fetchImpl: model,
      kind: 'vllm', overrides: { dry_multiplier: 0.8 },
    });
    expect(result.unsupported).toEqual(['dry_multiplier']);
  });

  it('keeps the harness default when no temperature is given', async () => {
    // The point of comparison is the value the harness actually runs at, so absent means the
    // sampler's default rather than some second default invented here.
    const model = scriptedModel([{ tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] }]);
    await run(model);
    expect(bodyOf(model, 0).temperature).toBe(0.3);
  });

  it('caps tool-call arguments in the trace, keeping the head where the path is', async () => {
    // write_file carries the whole file, so an uncapped trace grows without bound while every
    // other field is clipped — and an experiment stores every run's trace in one document.
    const big = 'x'.repeat(20_000);
    const model = scriptedModel([
      { tool_calls: [toolCall('write_file', { path: 'src/index.ts', content: big })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] },
    ]);
    const result = await runAgentLoop({
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
    // A counter on every turn is noise the model learns to skip. The number only changes a
    // decision when there is barely any left.
    const { model, done } = runner(10);
    await done;

    expect(toolMessageOf(model, 1).content).not.toMatch(/steps? left/i);
  });

  it('warns near the end, and says what to do about it', async () => {
    /**
     * The budget was stated once in the system prompt and never again, so an agent twenty steps in
     * had no way to know where it was. The axe then falls with everything uncommitted — which is
     * how one leaf spent three attempts and 91,818 tokens without getting past `mkdir`.
     */
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
    // An extra turn would cost a step, which is a perverse way to warn someone about running out.
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
    // The trace clips tool results to 1,200 characters while the model was sent up to 8,000 — so
    // reading a trace tells you roughly what happened and misrepresents what the model saw.
    const box = sandbox({
      exec: vi.fn(async () => ({ stdout: 'X'.repeat(3000), stderr: '', exitCode: 0, timedOut: false })),
    });
    const model = scriptedModel([
      { tool_calls: [toolCall('run_command', { command: 'ls' })] },
      { tool_calls: [toolCall('finish', { succeeded: true, summary: 'ok' })] },
    ]);
    const result = await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do the thing', sandbox: box, fetchImpl: model,
      captureTrace: true,
    });

    const convo = result.conversation!;
    expect(convo.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    // The system prompt in full, as sent.
    expect(convo[0]!.content).toMatch(/NO outbound network/);
    expect(convo[1]!.content).toMatch(/^Begin\./);
    // The assistant turn carries the calls it actually made.
    expect(convo[2]!.toolCalls?.[0]?.name).toBe('run_command');
    // The tool result as the MODEL received it, not the trace's shorter copy.
    const toolMessage = convo[3]!;
    expect(toolMessage.toolCallId).toBe('c1');
    expect(toolMessage.content.length).toBeGreaterThan(1200);
    expect(result.trace![0]!.toolResults[0]!.result.length).toBeLessThanOrEqual(1300);
  });

  it('is absent when the run is not being recorded', async () => {
    // A leaf execution has no use for it and would write hundreds of kilobytes per attempt.
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
    const result = await runAgentLoop({
      baseUrl: 'http://model', taskContext: 'Do it', sandbox: box, fetchImpl: model, captureTrace: true,
    });
    expect(result.conversation!.find((m) => m.role === 'tool')!.truncated).toBe(true);
  });
});
