import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn as spawnProcess } from 'node:child_process';

export interface SpawnRig {
  spawn: typeof spawnProcess;
  ran: string[][];
}

export function fakeSpawn(answer: (argv: string[]) => { stdout?: string; stderr?: string; code?: number } | undefined): SpawnRig {
  const ran: string[][] = [];
  const spawn = ((command: string, args: string[]) => {
    const argv = [command, ...args];
    ran.push(argv);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const said = answer(argv) ?? {};
    setImmediate(() => {
      if (said.stderr) child.stderr.write(said.stderr);
      child.stdout.end(said.stdout ?? `${command} output`);
      child.emit('close', said.code ?? 0);
    });
    return child;
  }) as unknown as typeof spawnProcess;
  return { spawn, ran };
}
