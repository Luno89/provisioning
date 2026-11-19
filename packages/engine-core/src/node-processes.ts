import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childEnv } from './child-env.js';
import { ProcessNotStarted, SIGNALLED, type Followed, type Heard, type Io, type Named, type ProcessResult, type ProcessRun, type Processes, type Streams } from './processes.js';

export type EnvOf = (named: Named | undefined) => Record<string, string>;

const present = (named: Named): Record<string, string> =>
  Object.fromEntries(Object.entries(named).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const inheritedOnly: EnvOf = (named) => childEnv(named);

export const withEnvironment = (environment: Named): EnvOf => (named) => present({ ...environment, ...named });

const ending = (code: number | null, signal: NodeJS.Signals | null): Pick<ProcessResult, 'code' | 'signal'> =>
  code !== null ? { code } : signal !== null ? { code: SIGNALLED, signal } : { code: 1 };

const notPiped = (err: NodeJS.ErrnoException): boolean => err.code !== 'EPIPE';

interface Child {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<Pick<ProcessResult, 'code' | 'signal'>>;
  over(): boolean;
  failed(err: Error): void;
}

function begin(envOf: EnvOf, run: ProcessRun, group: boolean): Child {
  const child = spawn(run.command, [...run.args], { cwd: run.cwd, env: envOf(run.env), stdio: ['pipe', 'pipe', 'pipe'], detached: group });
  let failed: (err: Error) => void = () => undefined;
  let over = false;
  const closed = new Promise<Pick<ProcessResult, 'code' | 'signal'>>((done, fail) => {
    failed = fail;
    child.on('error', (err) => { fail(child.pid === undefined ? new ProcessNotStarted(run, err) : err); });
    child.on('close', (code, signal) => {
      over = true;
      done(ending(code, signal));
    });
  });
  child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (notPiped(err)) failed(err); });
  return { child, closed, over: () => over, failed };
}

function collect(stream: NodeJS.ReadableStream, hear: ((chunk: string) => void) | undefined): () => string {
  const chunks: Buffer[] = [];
  const decoder = new TextDecoder('utf8');
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    if (hear) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) hear(text);
    }
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

function feed(started: Child, input: Io['input']): void {
  const { child } = started;
  if (input === undefined) child.stdin.end();
  else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
  else {
    input.on('error', (err: Error) => { child.kill('SIGKILL'); started.failed(err); });
    input.pipe(child.stdin);
  }
}

function stopper(started: Child, group: boolean): (signal?: NodeJS.Signals) => void {
  const { child } = started;
  return (signal = 'SIGKILL') => {
    if (started.over()) return;
    if (!group || child.pid === undefined) {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  };
}

function started(envOf: EnvOf, run: ProcessRun, io: Io): Followed {
  const group = io.group === true;
  const begun = begin(envOf, run, group);
  const { child } = begun;
  const { output, heard } = io;
  const written = output
    ? new Promise<void>((done, fail) => { output.on('finish', done); output.on('error', fail); })
    : Promise.resolve();
  const stdout = output ? () => '' : collect(child.stdout, heard?.stdout);
  if (output) child.stdout.pipe(output);
  const stderr = collect(child.stderr, heard?.stderr);
  feed(begun, io.input ?? run.input);
  const ended = Promise.all([begun.closed, written]).then(([end]) => ({ ...end, stdout: stdout(), stderr: stderr() }));
  return { pid: child.pid, stop: stopper(begun, group), ended };
}

export interface NodeProcesses extends Processes, Streams {}

export function spawnedProcesses(envOf: EnvOf): NodeProcesses {
  return {
    run: (run: ProcessRun, heard?: Heard) => started(envOf, run, { heard }).ended,
    pipe: (run: ProcessRun, input: NodeJS.ReadableStream) => started(envOf, run, { input }).ended,
    follow: (run: ProcessRun, onOutput: (chunk: string) => void) => started(envOf, { ...run, input: undefined }, { heard: { stdout: onOutput } }),
    start: (run: ProcessRun, io: Io = {}) => started(envOf, run, io),
  };
}

export const nodeRunner: NodeProcesses = spawnedProcesses(inheritedOnly);

const local = nodeRunner;

export const nodeProcesses: Processes = local;

export const nodeStreams: Streams = local;
