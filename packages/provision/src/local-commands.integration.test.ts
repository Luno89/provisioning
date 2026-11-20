import { describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { localCommands } from './local-commands.js';
import { runSteps, StepFailed, type Step } from './steps.js';
import { terminalReporter } from './terminal-reporter.js';

const commands = () => localCommands(process.env);

describe('localCommands', () => {
  it('reports a signal that stopped the command', async () => {
    const err: unknown = await commands().run({ command: 'sh', args: ['-c', 'kill -KILL $$'] }, { line: () => undefined }).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toMatchObject({ ending: { signal: 'SIGKILL' } });
  });

  it('gives a real command its stdin and environment, and says a program that is not there could not start', async () => {
    const said = await commands().run({ command: 'sh', args: ['-c', 'cat; echo " $KOALA_PROVISION_SAID"'], stdin: 'piped', env: { KOALA_PROVISION_SAID: 'hello' } }, { line: () => undefined });
    expect(said).toEqual({ code: 0, stdout: 'piped hello\n' });
    const err: unknown = await commands().run({ command: 'koala-provision-no-such-program' }, { line: () => undefined }).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toMatchObject({ message: 'koala-provision-no-such-program could not start: spawn koala-provision-no-such-program ENOENT' });
  });

  it('runs in the folder it is given', async () => {
    expect((await commands().run({ command: 'pwd', cwd: '/' }, { line: () => undefined })).stdout).toBe('/\n');
  });
});

describe('steps running real commands', () => {
  interface Folder { path: string }
  const runner = commands();
  const made = (id: string, script: string): Step<Folder> => ({
    id,
    title: `Making ${id}`,
    check: async (ctx) => ((await runner.run({ command: 'test', args: ['-e', `${ctx.path}/${id}`], accept: [0, 1] }, { line: () => undefined })).code === 0 ? { done: true } : { done: false, why: `${ctx.path}/${id} is not there` }),
    apply: async (ctx, progress) => { await runner.run({ command: 'sh', args: ['-c', script], cwd: ctx.path }, progress); },
  });

  it('applies a step through a real command, then finds it already done the next time', async () => {
    const path = (await runner.run({ command: 'mktemp', args: ['-d'] }, { line: () => undefined })).stdout.trim();
    const first = memoryReporter();
    await runSteps([made('marker', 'echo making the marker; touch marker')], { path }, first);
    expect(first.reported.map((entry) => entry.kind)).toEqual(['started', 'line', 'done']);
    expect(first.linesOf('marker')).toEqual(['making the marker']);
    const second = memoryReporter();
    await runSteps([made('marker', 'exit 1')], { path }, second);
    expect(second.reported.map((entry) => entry.kind)).toEqual(['started', 'already-done']);
    await runner.run({ command: 'rm', args: ['-rf', path] }, { line: () => undefined });
  });

  it('fails a step whose command failed, with the command and what it printed', async () => {
    const path = (await runner.run({ command: 'mktemp', args: ['-d'] }, { line: () => undefined })).stdout.trim();
    const reporter = memoryReporter();
    const err: unknown = await runSteps([made('broken', 'echo checking the disk; echo no space left >&2; exit 28')], { path }, reporter).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(StepFailed);
    const failure = err as StepFailed;
    expect(failure.why).toContain('exited with 28');
    expect([...failure.tail].sort()).toEqual(['checking the disk', 'no space left']);
    await runner.run({ command: 'rm', args: ['-rf', path] }, { line: () => undefined });
  });
});

describe('a run on a screen that is not a terminal', () => {
  it('shows each step numbered with every line its real command printed, and where it failed', async () => {
    const written: string[] = [];
    const runner = commands();
    const echo = (id: string, script: string): Step<null> => {
      let ran = false;
      return {
        id,
        title: `Running ${id}`,
        check: async () => (ran ? { done: true } : { done: false, why: `${id} has not run` }),
        apply: async (_ctx, progress) => {
          await runner.run({ command: 'sh', args: ['-c', script] }, progress);
          ran = true;
        },
      };
    };
    const err: unknown = await runSteps([echo('first', 'echo hello'), echo('second', 'echo almost; exit 4')], null, terminalReporter({ write: (text: string) => written.push(text) })).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(StepFailed);
    expect(written.join('')).toBe(`\n[1] Running first\n    hello\n  done\n\n[2] Running second\n    almost\n  failed: sh -c 'echo almost; exit 4' exited with 4\n`);
  });
});
