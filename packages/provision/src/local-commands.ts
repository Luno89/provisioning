import { spawnedProcesses, withEnvironment } from '@koala/engine-core/node-processes';
import { ProcessNotStarted, type Processes } from '@koala/engine-core/processes';
import { argvOf, commandOutput, type CommandRunner, type Ending } from './commands.js';

export function commandsOver(processes: Processes): CommandRunner {
  return {
    run: async (command, progress) => {
      const [program, ...args] = argvOf(command);
      const output = commandOutput(command, progress);
      const env = command.sudo ? undefined : command.env;
      const ending: Ending = await processes.run(
        { command: program!, args, input: command.stdin ?? '', ...(env !== undefined ? { env } : {}), ...(command.cwd !== undefined ? { cwd: command.cwd } : {}) },
        { stdout: (chunk) => { output.stdout(chunk); }, stderr: (chunk) => { output.stderr(chunk); } },
      ).then(
        (result) => (result.signal !== undefined ? { signal: result.signal } : { code: result.code }),
        (err: unknown) => {
          if (err instanceof ProcessNotStarted) return { notStarted: err.reason };
          throw err;
        },
      );
      return output.ended(ending);
    },
  };
}

export function localCommands(environment: Readonly<Record<string, string | undefined>>): CommandRunner {
  return commandsOver(spawnedProcesses(withEnvironment(environment)));
}
