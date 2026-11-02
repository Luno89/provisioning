import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitProcesses {
  run(run: { command: string; args: readonly string[]; env?: Readonly<Record<string, string | undefined>> | undefined; input?: string | undefined }): Promise<GitResult>;
}

export const gitOnThisMachine: GitProcesses = {
  run: ({ command, args, env, input }) => new Promise<GitResult>((done, failed) => {
    const child = spawn(command, [...args], { env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', failed);
    child.on('close', (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  }),
};
