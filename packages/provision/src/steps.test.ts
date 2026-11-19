import { describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { removeSteps, runSteps, StepFailed, TAIL_LINES, type Step, type StepState } from './steps.js';

interface Host { installed: Set<string>; applied: string[] }

const host = (...installed: string[]): Host => ({ installed: new Set(installed), applied: [] });

const install = (id: string, lines: string[] = []): Step<Host> => ({
  id,
  title: `Installing ${id}`,
  check: async (ctx) => (ctx.installed.has(id) ? { done: true } : { done: false, why: `${id} is not installed` }),
  apply: async (ctx, progress) => {
    for (const line of lines) progress.line(line);
    ctx.applied.push(id);
    ctx.installed.add(id);
  },
});

const failedOf = async (run: Promise<void>): Promise<StepFailed> => {
  const err: unknown = await run.then(() => undefined, (thrown: unknown) => thrown);
  if (!(err instanceof StepFailed)) throw new Error(`expected the run to fail with StepFailed, it ended with ${String(err)}`);
  return err;
};

describe('runSteps', () => {
  it('applies each step that is not done, in order, and says each started and finished', async () => {
    const ctx = host();
    const reporter = memoryReporter();
    await runSteps([install('docker', ['pulling']), install('k3s')], ctx, reporter);
    expect(ctx.applied).toEqual(['docker', 'k3s']);
    expect(reporter.reported).toEqual([
      { kind: 'started', id: 'docker' },
      { kind: 'line', id: 'docker', text: 'pulling' },
      { kind: 'done', id: 'docker' },
      { kind: 'started', id: 'k3s' },
      { kind: 'done', id: 'k3s' },
    ]);
  });

  it('leaves a step that is already done alone and says so', async () => {
    const ctx = host('docker');
    const reporter = memoryReporter();
    await runSteps([install('docker'), install('k3s')], ctx, reporter);
    expect(ctx.applied).toEqual(['k3s']);
    expect(reporter.reported.slice(0, 2)).toEqual([{ kind: 'started', id: 'docker' }, { kind: 'already-done', id: 'docker' }]);
  });

  it('fails with the check\'s reason and what the step printed when applying did not make it done, and runs nothing after it', async () => {
    const ctx = host();
    const reporter = memoryReporter();
    const stubborn: Step<Host> = {
      id: 'firewall',
      title: 'Opening the firewall',
      check: async (): Promise<StepState> => ({ done: false, why: 'port 6443 is still closed' }),
      apply: async (_ctx, progress) => { progress.line('firewall-cmd: success'); },
    };
    const failure = await failedOf(runSteps([stubborn, install('k3s')], ctx, reporter));
    expect(failure.stepId).toBe('firewall');
    expect(failure.title).toBe('Opening the firewall');
    expect(failure.why).toBe('port 6443 is still closed');
    expect(failure.tail).toEqual(['firewall-cmd: success']);
    expect(failure.message).toContain('Opening the firewall');
    expect(failure.message).toContain('port 6443 is still closed');
    expect(ctx.applied).toEqual([]);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'failed', id: 'firewall', why: 'port 6443 is still closed', tail: ['firewall-cmd: success'] });
  });

  it('fails with the error\'s message and the tail when applying throws', async () => {
    const broken: Step<Host> = {
      id: 'k3s',
      title: 'Installing k3s',
      check: async () => ({ done: false, why: 'k3s is not installed' }),
      apply: async (_ctx, progress) => {
        progress.line('downloading');
        throw new Error('the checksum did not match');
      },
    };
    const failure = await failedOf(runSteps([broken], host(), memoryReporter()));
    expect(failure.why).toBe('the checksum did not match');
    expect(failure.tail).toEqual(['downloading']);
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it('fails with where it was when the check itself throws', async () => {
    const unreadable: Step<Host> = {
      id: 'docker',
      title: 'Installing Docker',
      check: async () => { throw new Error('permission denied reading /var/run/docker.sock'); },
      apply: async () => undefined,
    };
    const failure = await failedOf(runSteps([unreadable], host(), memoryReporter()));
    expect(failure.stepId).toBe('docker');
    expect(failure.why).toContain('permission denied reading /var/run/docker.sock');
  });

  it('keeps only the last lines a step printed in its failure', async () => {
    const chatty: Step<Host> = {
      id: 'build',
      title: 'Building',
      check: async () => ({ done: false, why: 'not built' }),
      apply: async (_ctx, progress) => { for (let line = 1; line <= TAIL_LINES + 5; line += 1) progress.line(`line ${line}`); },
    };
    const failure = await failedOf(runSteps([chatty], host(), memoryReporter()));
    expect(failure.tail).toHaveLength(TAIL_LINES);
    expect(failure.tail[0]).toBe('line 6');
    expect(failure.tail.at(-1)).toBe(`line ${TAIL_LINES + 5}`);
  });

  it('waits for the reporter before going on, so a reporter that sends progress elsewhere keeps its order', async () => {
    const order: string[] = [];
    const slow = { ...memoryReporter(), started: async () => { await new Promise((resolve) => setImmediate(resolve)); order.push('reported'); } };
    const step: Step<Host> = { ...install('docker'), check: async (ctx) => { order.push('checked'); return ctx.installed.has('docker') ? { done: true } : { done: false, why: 'no' }; } };
    await runSteps([step], host(), slow);
    expect(order[0]).toBe('reported');
  });
});

const removable = (id: string, removed: string[], lines: string[] = []): Step<Host> => ({
  ...install(id),
  remove: async (ctx, progress) => {
    for (const line of lines) progress.line(line);
    ctx.installed.delete(id);
    removed.push(id);
  },
});

describe('removeSteps', () => {
  it('removes what each step made, the last made first, saying each started and finished', async () => {
    const removed: string[] = [];
    const ctx = host('folder', 'mongo');
    const reporter = memoryReporter();
    await removeSteps([removable('folder', removed), install('room'), removable('mongo', removed, ['mongod stopped'])], ctx, reporter);
    expect(removed).toEqual(['mongo', 'folder']);
    expect(reporter.reported).toEqual([
      { kind: 'started', id: 'mongo' },
      { kind: 'line', id: 'mongo', text: 'mongod stopped' },
      { kind: 'done', id: 'mongo' },
      { kind: 'started', id: 'folder' },
      { kind: 'done', id: 'folder' },
    ]);
  });

  it('removes every step even when one fails, and then fails with where and why', async () => {
    const removed: string[] = [];
    const stuck: Step<Host> = { ...install('mongo'), remove: async (_ctx, progress) => { progress.line('mongod would not stop'); throw new Error('the port is still held'); } };
    const failure = await failedOf(removeSteps([removable('folder', removed), stuck], host('folder', 'mongo'), memoryReporter()));
    expect(removed).toEqual(['folder']);
    expect(failure.stepId).toBe('mongo');
    expect(failure.why).toBe('removing it failed: the port is still held');
    expect(failure.tail).toEqual(['mongod would not stop']);
  });
});
