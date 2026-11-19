export type Named = Readonly<Record<string, string | undefined>>;

export interface ProcessRun {
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: Named | undefined;
  input?: string | Buffer | undefined;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: string;
}

export interface Heard {
  stdout?(chunk: string): void;
  stderr?(chunk: string): void;
}

export interface Processes {
  run(run: ProcessRun, heard?: Heard): Promise<ProcessResult>;
}

export interface Followed {
  readonly pid: number | undefined;
  stop(signal?: NodeJS.Signals): void;
  exited: Promise<Pick<ProcessResult, 'code' | 'signal'>>;
  ended: Promise<ProcessResult>;
}

export interface Io {
  input?: string | Buffer | NodeJS.ReadableStream | undefined;
  output?: NodeJS.WritableStream | undefined;
  heard?: Heard | undefined;
  group?: boolean | undefined;
}

export interface Streams {
  pipe(run: ProcessRun, input: NodeJS.ReadableStream): Promise<ProcessResult>;
  follow(run: ProcessRun, onOutput: (chunk: string) => void): Followed;
  start(run: ProcessRun, io?: Io): Followed;
}

export const SIGNALLED = 128;

export class ProcessFailed extends Error {
  constructor(readonly run: ProcessRun, readonly result: ProcessResult) {
    super(`${run.command} ${run.args.join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
    this.name = 'ProcessFailed';
  }
}

export class ProcessNotStarted extends Error {
  readonly code: string | undefined;
  readonly reason: string;

  constructor(readonly run: ProcessRun, why: Error & { code?: unknown }) {
    super(`${run.command} could not start: ${why.message}`);
    this.name = 'ProcessNotStarted';
    this.reason = why.message;
    this.code = typeof why.code === 'string' ? why.code : undefined;
  }
}

export async function succeeded(processes: Processes, run: ProcessRun): Promise<string> {
  const result = await processes.run(run);
  if (result.code !== 0) throw new ProcessFailed(run, result);
  return result.stdout;
}
