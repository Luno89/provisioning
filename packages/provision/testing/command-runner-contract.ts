import { describe, expect, it } from 'vitest';
import { CommandFailed, type Command, type CommandRunner } from '../src/commands.js';
import type { Progress } from '../src/steps.js';

export const CONTRACT = {
  bothStreams: { command: 'sh', args: ['-c', 'printf "one\\ntwo\\n"; printf "three\\n" >&2'] },
  unfinishedLine: { command: 'sh', args: ['-c', 'printf "partial"'] },
  failing: { command: 'sh', args: ['-c', 'echo before; exit 3'] },
  redrawn: { command: 'sh', args: ['-c', 'printf "10%%\\r20%%\\rdone\\n"'] },
  echoed: { command: 'cat', stdin: 'piped\nin' },
  withEnv: { command: 'sh', args: ['-c', 'echo "$KOALA_PROVISION_SAID"'], env: { KOALA_PROVISION_SAID: 'hello' } },
  missing: { command: 'koala-provision-no-such-program' },
} as const satisfies Record<string, Command>;

const listening = (): Progress & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, line: (text) => { lines.push(text); } };
};

const failureOf = async (run: Promise<unknown>): Promise<CommandFailed> => {
  const err: unknown = await run.then(() => undefined, (thrown: unknown) => thrown);
  if (!(err instanceof CommandFailed)) throw new Error(`expected CommandFailed, the run ended with ${String(err)}`);
  return err;
};

export function commandRunnerContract(name: string, make: () => CommandRunner): void {
  describe(`${name} as a command runner`, () => {
    it('streams each line of both outputs to the step and resolves with the code and what it printed to stdout', async () => {
      const progress = listening();
      const ran = await make().run(CONTRACT.bothStreams, progress);
      expect(ran).toEqual({ code: 0, stdout: 'one\ntwo\n' });
      expect([...progress.lines].sort()).toEqual(['one', 'three', 'two']);
    });

    it('streams a last line that has no newline', async () => {
      const progress = listening();
      await make().run(CONTRACT.unfinishedLine, progress);
      expect(progress.lines).toEqual(['partial']);
    });

    it('streams each redraw of a progress bar as its own line', async () => {
      const progress = listening();
      await make().run(CONTRACT.redrawn, progress);
      expect(progress.lines).toEqual(['10%', '20%', 'done']);
    });

    it('rejects a non-zero exit with the command, its code and the tail of what it printed', async () => {
      const progress = listening();
      const failure = await failureOf(make().run(CONTRACT.failing, progress));
      expect(failure.argv).toEqual(['sh', '-c', 'echo before; exit 3']);
      expect(failure.code).toBe(3);
      expect(failure.tail).toEqual(['before']);
      expect(failure.message).toBe(`sh -c 'echo before; exit 3' exited with 3`);
      expect(progress.lines).toEqual(['before']);
    });

    it('resolves with a code the caller said it accepts', async () => {
      expect(await make().run({ ...CONTRACT.failing, accept: [0, 3] }, listening())).toEqual({ code: 3, stdout: 'before\n' });
    });

    it('gives the command its stdin', async () => {
      const progress = listening();
      expect(await make().run(CONTRACT.echoed, progress)).toEqual({ code: 0, stdout: 'piped\nin' });
      expect(progress.lines).toEqual(['piped', 'in']);
    });

    it('gives the command its environment', async () => {
      expect((await make().run(CONTRACT.withEnv, listening())).stdout).toBe('hello\n');
    });

    it('rejects a program that is not there, saying it could not start', async () => {
      const failure = await failureOf(make().run(CONTRACT.missing, listening()));
      expect(failure.code).toBeUndefined();
      expect(failure.message).toContain('koala-provision-no-such-program could not start');
    });
  });
}
