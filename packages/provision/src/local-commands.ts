import { spawn } from 'node:child_process';
import { ignore } from '@koala/engine-core/failures';
import { argvOf, commandOutput, type CommandRunner, type Ending } from './commands.js';

export function localCommands(environment: Readonly<Record<string, string | undefined>>): CommandRunner {
  return {
    run: (command, progress) => new Promise((resolve, reject) => {
      const [program, ...args] = argvOf(command);
      const output = commandOutput(command, progress);
      let settled = false;
      const settle = (ending: Ending): void => {
        if (settled) return;
        settled = true;
        try {
          resolve(output.ended(ending));
        } catch (err) {
          reject(err as Error);
        }
      };
      const child = spawn(program!, args, {
        env: { ...environment, ...(command.sudo ? {} : command.env) },
        ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      });
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output.stdout(chunk); });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output.stderr(chunk); });
      child.on('error', (err) => { settle({ notStarted: err.message }); });
      child.on('close', (code, signal) => {
        if (code !== null) settle({ code });
        else if (signal !== null) settle({ signal });
      });
      child.stdin.on('error', ignore('a command that stops before reading all its stdin ends on its own exit, which settles the run'));
      child.stdin.end(command.stdin ?? '');
    }),
  };
}
