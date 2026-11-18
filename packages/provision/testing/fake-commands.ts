import { commandOutput, type Command, type CommandRunner } from '../src/commands.js';

export interface Answer {
  code?: number;
  stdout?: string;
  stderr?: string;
  signal?: string;
}

export interface FakeCommands extends CommandRunner {
  readonly ran: Command[];
}

export function fakeCommands(answer: (command: Command) => Answer | undefined): FakeCommands {
  const ran: Command[] = [];
  return {
    ran,
    run: async (command, progress) => {
      ran.push(command);
      const output = commandOutput(command, progress);
      const answered = answer(command);
      if (!answered) return output.ended({ notStarted: `spawn ${command.command} ENOENT` });
      if (answered.stdout !== undefined) output.stdout(answered.stdout);
      if (answered.stderr !== undefined) output.stderr(answered.stderr);
      return output.ended(answered.signal !== undefined ? { signal: answered.signal } : { code: answered.code ?? 0 });
    },
  };
}
