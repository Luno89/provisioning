import { describe, it, expect, vi } from 'vitest';
import { AuthoringService, acceptedTasks, type ValidatedTask } from './AuthoringService.js';
import type { DraftTask } from '../lib/experiment-authoring.js';

/**
 * The sandbox half of the gate.
 *
 * The rules themselves are `judgeEmptyRun`'s and tested there; what matters here is the discipline
 * around them — that `/work` is emptied between commands, that the model-authored command is never
 * interpolated into a shell string, and that the pod is destroyed whatever happens. Each of those
 * failing would reintroduce the exact bug the gate exists to prevent, one layer down.
 */
const task = (over: Partial<DraftTask> = {}): DraftTask => ({
  name: 'fib',
  prompt: 'Create /work/fib.js',
  verifyCommand: 'cd /work && node test.js',
  ...over,
});

/** Resets and directory listings are bookkeeping; everything else is a verify run. */
const isListing = (c: string) => c.startsWith('cd /work 2>/dev/null && ls');
const isBookkeeping = (c: string) => c.startsWith('rm -rf') || isListing(c);

/** A workspace that records what it was asked to do and answers with scripted exit codes. */
const fakeWorkspaces = (exitCodes: number[] = [1], created: string[] = [], seeded: string[] = []) => {
  let listed = 0;
  const execs: { command: string; positional: string[] }[] = [];
  let call = 0;
  return {
    execs,
    created: [] as unknown[],
    destroyed: [] as string[],
    service: {
      create: vi.fn(async function (this: any, spec: unknown) { this.created?.push(spec); }),
      writeFile: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      exec: vi.fn(async (_id: string, command: string, _ms?: number, positional: string[] = []) => {
        execs.push({ command, positional });
        // Reset and the post-run listing are bookkeeping — only verify calls consume a scripted code.
        if (command.startsWith('rm -rf')) return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        if (command.startsWith('cd /work 2>/dev/null && ls')) {
          // Alternates: the first listing per task is the post-seed baseline, the second is after
          // the verify command ran. `created` is what the command added on top of the seed.
          const isBaseline = listed++ % 2 === 0;
          const stdout = (isBaseline ? seeded : [...seeded, ...created]).join('\n');
          return { stdout, stderr: '', exitCode: 0, timedOut: false };
        }
        const exitCode = exitCodes[Math.min(call++, exitCodes.length - 1)]!;
        return { stdout: '', stderr: 'boom', exitCode, timedOut: false };
      }),
    } as any,
  };
};

describe('validateOnEmptyWorkspace', () => {
  it('accepts a command that fails with nothing present', async () => {
    const w = fakeWorkspaces([1]);
    const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [task()]);

    expect(result!.ok).toBe(true);
    expect(result!.exitCode).toBe(1);
  });

  it('rejects a command that passes with nothing present', async () => {
    // `cd /work && ls` looks ordinary and exits 0 on an empty directory. A suite built from
    // commands like it reports every variant as a winner.
    const w = fakeWorkspaces([0]);
    const [result] = await new AuthoringService(w.service)
      .validateOnEmptyWorkspace('u1', [task({ verifyCommand: 'cd /work && ls' })]);

    expect(result!.ok).toBe(false);
    expect(result!.reason).toMatch(/not checking anything/);
  });

  it('empties /work before every command, including the first', async () => {
    // A verify command may create files, and a leftover artefact from one command is exactly what
    // would make the next pass spuriously — the same bug, one command later.
    const w = fakeWorkspaces([1, 1]);
    await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [task(), task({ name: 'b' })]);

    const commands = w.execs.map((e) => e.command);
    expect(commands.filter((c) => c.startsWith('rm -rf'))).toHaveLength(2);
    // Every verify has a reset before it with nothing but listings in between. Stated as a
    // relationship rather than by position: bookkeeping steps have been inserted twice now, and
    // each time a positional assertion would have gone quietly vacuous instead of failing.
    commands.forEach((c, i) => {
      if (isBookkeeping(c)) return;
      const preceding = commands.slice(0, i).filter((x) => !isListing(x));
      expect(preceding[preceding.length - 1]).toMatch(/^rm -rf/);
    });
  });

  it('never interpolates the model-authored command into the shell string', async () => {
    // It was written by a model. Splicing it in would put it in the container's process list and
    // make any quote in it a shell injection.
    const nasty = 'cd /work && grep -q "it\'s" out.txt; rm -rf /';
    const w = fakeWorkspaces([1]);
    await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [task({ verifyCommand: nasty })]);

    const verify = w.execs.find((e) => !isBookkeeping(e.command))!;
    expect(verify.command).not.toContain('rm -rf /');
    expect(verify.command).not.toContain('grep');
    expect(verify.positional).toEqual([nasty]);
  });

  it('destroys the pod even when a command throws', async () => {
    // An orphaned validation pod is a pod nothing will ever come back for.
    const w = fakeWorkspaces();
    w.service.exec = vi.fn(async () => { throw new Error('cluster went away'); });

    await expect(new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [task()]))
      .rejects.toThrow(/cluster went away/);
    expect(w.service.destroy).toHaveBeenCalled();
  });

  it('creates no sandbox at all for an empty batch', async () => {
    const w = fakeWorkspaces();
    expect(await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [])).toEqual([]);
    expect(w.service.create).not.toHaveBeenCalled();
  });

  it('returns a verdict per task rather than filtering', async () => {
    // A rejected proposal is worth showing with its reason — it is often a small edit from good.
    const w = fakeWorkspaces([1, 0]);
    const results = await new AuthoringService(w.service)
      .validateOnEmptyWorkspace('u1', [task({ name: 'a' }), task({ name: 'b' })]);

    expect(results.map((r) => [r.name, r.ok])).toEqual([['a', true], ['b', false]]);
  });
});

describe('a task whose input only exists at verification time', () => {
  it('does not blame the seed for files the task legitimately starts with', () => {
    // The listing cannot tell a seeded file from one the command wrote, so it is a difference
    // rather than a listing — otherwise a correctly posed task is rejected for the exact sin it
    // was rewritten to avoid.
    return (async () => {
      const w = fakeWorkspaces([1], [], ['data.txt']);
      const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [
        task({
          prompt: 'There is a file data.txt. Write read.js which prints its contents.',
          seed: [{ path: 'data.txt', content: 'test data' }],
        }),
      ]);
      expect(result!.reason).toBeUndefined();
      expect(result!.ok).toBe(true);
    })();
  });

  it('is rejected even though its verify command is a real check', () => {
    // Two different questions: `judgeEmptyRun` proves the command is not vacuous, and this proves
    // the task is answerable. The real authored case failed correctly on an empty workspace and
    // still could never pass, because the agent never had the file.
    return (async () => {
      const w = fakeWorkspaces([1], ['data.txt', 'read.js']);
      const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [
        task({ prompt: 'Read /work/data.txt and print its contents.', verifyCommand: "cd /work && echo x > data.txt && node read.js" }),
      ]);

      expect(result!.ok).toBe(false);
      expect(result!.reason).toMatch(/creates data\.txt/);
      expect(result!.reason).toMatch(/nothing there/);
    })();
  });

  it('still accepts a task whose verify writes only scaffolding', () => {
    return (async () => {
      const w = fakeWorkspaces([1], ['.verify-tmp']);
      const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [
        task({ prompt: 'Create hello.js that prints PASS.' }),
      ]);
      expect(result!.ok).toBe(true);
    })();
  });
});

describe('the achievability half of the gate', () => {
  it('rejects a verify command that fails even on a correct solution', async () => {
    // The typo class. `grep -q 'Hello Wolrd'` fails on the seed and fails on a perfect answer, and
    // from one side those are indistinguishable — so a broken command reads as a hard task and
    // costs a sandbox per variant per repeat to discover otherwise.
    const w = fakeWorkspaces([1, 1]);   // fails on seed, then fails again on the solution
    const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [
      task({ solution: [{ path: 'hello.js', content: 'console.log("Hello World")' }] }),
    ]);

    expect(result!.ok).toBe(false);
    expect(result!.reason).toMatch(/the command is wrong, not the task/);
    expect(result!.solutionExitCode).toBe(1);
  });

  it('accepts a command that fails on the seed and passes on the solution', async () => {
    const w = fakeWorkspaces([1, 0]);
    const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [
      task({ solution: [{ path: 'hello.js', content: 'ok' }] }),
    ]);

    expect(result!.ok).toBe(true);
    expect(result!.exitCode).toBe(1);
    expect(result!.solutionExitCode).toBe(0);
  });

  it('writes the seed for both sides, so neither is measured against an empty directory', async () => {
    // The seed is the world the agent wakes up in, so it is the baseline the gate compares against.
    const w = fakeWorkspaces([1, 0]);
    await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [
      task({ seed: [{ path: 'data.txt', content: 'hello' }], solution: [{ path: 'read.js', content: 'x' }] }),
    ]);
    expect(w.service.writeFile).toHaveBeenCalledWith(expect.any(String), 'data.txt', 'hello');
    expect(w.service.writeFile).toHaveBeenCalledWith(expect.any(String), 'read.js', 'x');
  });

  it('ships a task with no solution on half the evidence, and only half', async () => {
    // Nothing to run a correct answer against, so achievability stays unproven rather than assumed.
    const w = fakeWorkspaces([1]);
    const [result] = await new AuthoringService(w.service).validateOnEmptyWorkspace('u1', [task()]);
    expect(result!.ok).toBe(true);
    expect(result!.solutionExitCode).toBeUndefined();
  });
});

describe('acceptedTasks', () => {
  it('keeps only what passed the gate, in the shape the create route stores', () => {
    const validated: ValidatedTask[] = [
      { ...task({ name: 'a', language: 'go' }), ok: true, exitCode: 1, output: '' },
      { ...task({ name: 'b' }), ok: false, reason: 'passes on an empty workspace', exitCode: 0, output: '' },
    ];
    expect(acceptedTasks(validated)).toEqual([
      { name: 'a', prompt: 'Create /work/fib.js', verifyCommand: 'cd /work && node test.js', language: 'go' },
    ]);
  });
});
