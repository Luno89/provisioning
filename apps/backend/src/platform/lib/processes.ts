export interface ProcessRun {
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  input?: string | Buffer | undefined;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Processes {
  run(run: ProcessRun): Promise<ProcessResult>;
}

export class ProcessFailed extends Error {
  constructor(readonly run: ProcessRun, readonly result: ProcessResult) {
    super(`${run.command} ${run.args.join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
    this.name = 'ProcessFailed';
  }
}

export async function succeeded(processes: Processes, run: ProcessRun): Promise<string> {
  const result = await processes.run(run);
  if (result.code !== 0) throw new ProcessFailed(run, result);
  return result.stdout;
}
