import { spawn, type ChildProcess } from 'node:child_process';
import type { Provider } from './service.js';
import { tail } from './tail.js';

export interface ProcessSpec {
  name: string;
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface ProcessProvider extends Provider<object> {
  pid(): number;
  onEnded(listener: (why: string) => void): void;
}

const LAST_LINES = 5;

export function processProvider(spec: ProcessSpec): ProcessProvider {
  let child: ChildProcess | undefined;
  let endedWhy: string | undefined;
  let stopping = false;
  let exited: Promise<void> = new Promise(() => undefined);
  const said = tail(LAST_LINES);
  const listeners: Array<(why: string) => void> = [];
  const heard = (chunk: Buffer): void => { for (const line of chunk.toString().split('\n')) if (line.trim()) said.add(line.trim()); };
  return {
    pid() {
      if (!child?.pid) throw new Error(`${spec.name} is not started`);
      return child.pid;
    },
    onEnded(listener) { listeners.push(listener); },
    running: async () => (child && !endedWhy ? { done: true } : { done: false, why: endedWhy ?? `${spec.name} is not started` }),
    async start() {
      endedWhy = undefined;
      const started = spawn(spec.command, [...spec.args], { env: spec.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      child = started;
      started.stdout.on('data', heard);
      started.stderr.on('data', heard);
      exited = new Promise((done) => {
        started.once('error', (err) => {
          endedWhy = `${spec.name} could not start: ${err.message}`;
          done();
        });
        started.once('exit', (code, signal) => {
          endedWhy = `${spec.name} ${signal ? `was killed by ${signal}` : `exited with ${code}`} (last said: ${said.lines().join(' | ') || 'nothing'})`;
          done();
          if (!stopping) for (const listener of listeners) listener(endedWhy);
        });
      });
    },
    ended: async () => endedWhy,
    ending: async () => {
      await exited;
      return endedWhy!;
    },
    async remove() {
      if (!child || endedWhy) return;
      stopping = true;
      child.kill('SIGTERM');
      await exited;
    },
  };
}
