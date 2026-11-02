import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';

export interface ShellOptions {
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ShellOutput {
  stdout: string;
  stderr: string;
}

export type Shell = (command: string, options?: ShellOptions) => Promise<ShellOutput>;

export const execShell: Shell = promisify(exec);

export interface StartOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export type StartProcess = (command: string, args: string[], options?: StartOptions) => ChildProcessWithoutNullStreams;

export const startProcess: StartProcess = (command, args, options) => spawn(command, args, options ?? {});
