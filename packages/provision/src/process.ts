import { nodeStreams } from '@koala/engine-core/node-processes';
import { ProcessNotStarted, type Followed, type Named, type Streams } from '@koala/engine-core/processes';
import type { Provider } from './service.js';
import { tail } from './tail.js';

export interface ProcessSpec {
  name: string;
  command: string;
  args: readonly string[];
  env?: Named;
}

export interface ProcessProvider extends Provider<object> {
  pid(): number;
  onEnded(listener: (why: string) => void): void;
}

const LAST_LINES = 5;

export function processProvider(spec: ProcessSpec, streams: Streams = nodeStreams): ProcessProvider {
  let running: Followed | undefined;
  let endedWhy: string | undefined;
  let stopping = false;
  let exited: Promise<void> = new Promise(() => undefined);
  const said = tail(LAST_LINES);
  const listeners: Array<(why: string) => void> = [];
  const heard = (chunk: string): void => { for (const line of chunk.split('\n')) if (line.trim()) said.add(line.trim()); };
  const lastSaid = (): string => said.lines().join(' | ') || 'nothing';
  return {
    pid() {
      if (running?.pid === undefined) throw new Error(`${spec.name} is not started`);
      return running.pid;
    },
    onEnded(listener) { listeners.push(listener); },
    running: async () => (running && !endedWhy ? { done: true } : { done: false, why: endedWhy ?? `${spec.name} is not started` }),
    async start() {
      endedWhy = undefined;
      const started = streams.start({ command: spec.command, args: spec.args, env: spec.env }, { heard: { stdout: heard, stderr: heard } });
      running = started;
      exited = started.ended.then(
        (result) => {
          endedWhy = `${spec.name} ${result.signal !== undefined ? `was killed by ${result.signal}` : `exited with ${result.code}`} (last said: ${lastSaid()})`;
          if (!stopping) for (const listener of listeners) listener(endedWhy);
        },
        (err: unknown) => {
          if (!(err instanceof ProcessNotStarted)) throw err;
          endedWhy = `${spec.name} could not start: ${err.reason}`;
        },
      );
    },
    ended: async () => endedWhy,
    ending: async () => {
      await exited;
      return endedWhy!;
    },
    async remove() {
      if (!running || endedWhy) return;
      stopping = true;
      running.stop('SIGTERM');
      await exited;
    },
  };
}
