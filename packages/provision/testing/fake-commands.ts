import { recordingProcesses } from '@koala/engine-core/testing/processes';
import type { Command, CommandRunner } from '../src/commands.js';
import { commandsOver } from '../src/local-commands.js';

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
      const answered = answer(command);
      return commandsOver(recordingProcesses(() => answered)).run(command, progress);
    },
  };
}
