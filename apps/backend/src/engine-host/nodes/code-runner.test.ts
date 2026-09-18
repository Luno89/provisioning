import { describe, it, expect, vi } from 'vitest';
import type { EnvironmentDriver, ExecResult } from '@koala/engine-core';
import { createCodeRunner, readOutputs, wrapBody } from './code-runner.js';
import type { RunTicket } from '../temporal/contracts.js';

const ticket: RunTicket = { runId: 'run-1', depth: 0, ownerId: 'user-1', agentSlug: 'koala', trigger: 'user' };

function sandbox(over: { exec?: () => Promise<ExecResult>; wrote?: Record<string, string> } = {}) {
  const files: Record<string, string> = {};

  const driver = {
    handle: () => ({ id: 'sandbox:1' }),
    exec: vi.fn(over.exec ?? (async () => {
      for (const [path, content] of Object.entries(over.wrote ?? {})) files[path] = content;
      return { stdout: '', stderr: '', exitCode: 0 };
    })),
    readFile: vi.fn(async (path: string) => files[path] ?? ''),
    writeFile: vi.fn(async (path: string, content: string) => { files[path] = content; }),
    listDir: vi.fn(async () => []),
    deleteFile: vi.fn(async () => undefined),
  } as unknown as EnvironmentDriver;

  return { driver, files };
}

const runnerFor = (driver: EnvironmentDriver | undefined) =>
  createCodeRunner({ environments: { forRun: async () => driver } });

const request = (over: Partial<Parameters<ReturnType<typeof runnerFor>['run']>[0]> = {}) => ({
  ticket,
  nodeId: 'shape',
  body: 'return { total: inputs.a + inputs.b }',
  inputs: { a: 1, b: 2 },
  timeoutMs: 5000,
  ...over,
});

describe('running a piece of code in the run\'s sandbox', () => {
  it('writes the body, its inputs and a place for its answer, then runs it', async () => {
    const { driver, files } = sandbox({ wrote: { '.koala/shape.out.json': '{"total":3}' } });

    const outcome = await runnerFor(driver).run(request());

    expect(outcome).toEqual({ ok: true, outputs: { total: 3 } });
    expect(files['.koala/shape.in.json']).toBe('{"a":1,"b":2}');
    expect(files['.koala/shape.mjs']).toContain('return { total: inputs.a + inputs.b }');
    expect(driver.exec).toHaveBeenCalledWith({ command: 'node .koala/shape.mjs', timeoutMs: 5000 });
  });

  it('says the code failed, with what it said, when it exits badly', async () => {
    const { driver } = sandbox({ exec: async () => ({ stdout: '', stderr: 'ReferenceError: nope is not defined', exitCode: 1 }) });

    expect(await runnerFor(driver).run(request())).toEqual({
      ok: false,
      error: 'the code failed: ReferenceError: nope is not defined',
    });
  });

  it('says it exited without explaining when it says nothing at all', async () => {
    const { driver } = sandbox({ exec: async () => ({ stdout: '', stderr: '', exitCode: 137 }) });

    expect(await runnerFor(driver).run(request())).toMatchObject({ ok: false, error: expect.stringContaining('exited 137') });
  });

  it('refuses when the run has no sandbox to run in', async () => {
    expect(await runnerFor(undefined).run(request())).toEqual({
      ok: false,
      error: 'this run has no sandbox, and code needs one to run in',
    });
  });

  it('keeps one node\'s files apart from another\'s', async () => {
    const { driver, files } = sandbox();

    await runnerFor(driver).run(request({ nodeId: 'first' }));
    await runnerFor(driver).run(request({ nodeId: 'second' }));

    expect(Object.keys(files).sort()).toContain('.koala/first.mjs');
    expect(Object.keys(files).sort()).toContain('.koala/second.mjs');
  });

  it('makes a file name out of a node id that is not one', async () => {
    const { driver, files } = sandbox();

    await runnerFor(driver).run(request({ nodeId: 'turn/call 1' }));

    expect(Object.keys(files)).toContain('.koala/turn-call-1.mjs');
  });
});

describe('what the body is wrapped in', () => {
  it('gives the body its inputs and writes what it returns where we can read it', () => {
    const wrapped = wrapBody('return { ok: true }', 'in.json', 'out.json');

    expect(wrapped).toContain('const inputs = JSON.parse(await readFile("in.json", \'utf8\'))');
    expect(wrapped).toContain('return { ok: true }');
    expect(wrapped).toContain('await writeFile("out.json", JSON.stringify(outputs ?? {}))');
  });
});

describe('reading back what the code handed over', () => {
  it('reads an object', () => {
    expect(readOutputs('{"a":1}')).toEqual({ ok: true, outputs: { a: 1 } });
  });

  it('treats an empty answer as handing nothing back', () => {
    expect(readOutputs('  ')).toEqual({ ok: true, outputs: {} });
  });

  it('refuses something that is not JSON', () => {
    expect(readOutputs('not json')).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
  });

  it('refuses a bare value, because outputs are named', () => {
    expect(readOutputs('[1,2]')).toMatchObject({ ok: false, error: expect.stringContaining('object of the values it declares') });
    expect(readOutputs('42')).toMatchObject({ ok: false });
  });
});
