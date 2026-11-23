import type { CommandRunner } from './commands.js';
import type { Progress } from './steps.js';

export const SUDO_REFRESH_MS = 60_000;
const PROMPT = '  [sudo] your password, asked once for all of this: ';

export type Every = (refresh: () => void, ms: number) => { stop(): void };

export interface KeptSudo extends CommandRunner {
  end(): void;
}

export interface KeptSudoOptions {
  lost(why: string): void;
  every?: Every;
  prompt?: string;
}

const realEvery: Every = (refresh, ms) => {
  const timer = setInterval(refresh, ms);
  timer.unref();
  return { stop: () => { clearInterval(timer); } };
};

const SILENT: Progress = { line: () => undefined };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function keptSudo(runner: CommandRunner, options: KeptSudoOptions): KeptSudo {
  const every = options.every ?? realEvery;
  let asked: Promise<void> | undefined;
  let refreshing: { stop(): void } | undefined;
  let ended = false;
  const refresh = (): void => {
    runner.run({ command: 'sudo', args: ['-n', '-v'] }, SILENT).then(
      () => undefined,
      (err: unknown) => { if (!ended) options.lost(`sudo no longer keeps your password, so it may ask again: ${messageOf(err)}`); },
    );
  };
  const ask = (progress: Progress): Promise<void> => {
    asked ??= runner.run({ command: 'sudo', args: ['-v', '-p', options.prompt ?? PROMPT] }, progress).then(
      () => {
        if (!ended) refreshing = every(refresh, SUDO_REFRESH_MS);
      },
      (err: unknown) => {
        asked = undefined;
        throw new Error(`sudo did not let this run as root: ${messageOf(err)}`, { cause: err });
      },
    );
    return asked;
  };
  return {
    run: async (command, progress) => {
      if (command.sudo) await ask(progress);
      return runner.run(command, progress);
    },
    end: () => {
      ended = true;
      refreshing?.stop();
    },
  };
}
