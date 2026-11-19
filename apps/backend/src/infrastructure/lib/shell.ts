import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from '@koala/engine-core/child-env';

export interface ShellOptions {
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface ShellOutput {
  stdout: string;
  stderr: string;
}

export type Shell = (command: string, options?: ShellOptions) => Promise<ShellOutput>;

const run = promisify(exec);

export const execShell: Shell = (command, options) => run(command, { env: childEnv(options?.env) });

export interface StartOptions {
  cwd?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

export type StartProcess = (command: string, args: string[], options?: StartOptions) => ChildProcessWithoutNullStreams;

export const startProcess: StartProcess = (command, args, options) => spawn(command, args, { ...(options?.cwd ? { cwd: options.cwd } : {}), env: childEnv(options?.env) });
