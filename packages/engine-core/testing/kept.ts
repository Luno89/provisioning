import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnedProcesses, withEnvironment } from '../src/node-processes.js';
import type { Followed, Io, ProcessRun } from '../src/processes.js';

const KEEPER = fileURLToPath(new URL('./keeper.ts', import.meta.url));

const exactly = spawnedProcesses(withEnvironment({}));

export function startKept(run: ProcessRun, io: Pick<Io, 'heard' | 'output'> = {}): Followed {
  return exactly.start({ ...run, command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', KEEPER, run.command, ...run.args] }, { ...io, input: new PassThrough(), group: true });
}
