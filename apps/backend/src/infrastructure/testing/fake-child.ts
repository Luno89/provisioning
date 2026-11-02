import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  events: EventEmitter;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

export function fakeChild(): FakeChild {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(events, { stdin, stdout, stderr }) as unknown as ChildProcessWithoutNullStreams;
  return { child, events, stdin, stdout, stderr };
}
