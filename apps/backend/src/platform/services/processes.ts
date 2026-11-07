import { spawn } from 'node:child_process';
import type { ProcessResult, ProcessRun, Processes, Streams } from '../lib/processes.js';

export const nodeProcesses: Processes = {
  run: (run: ProcessRun) => new Promise<ProcessResult>((done, failed) => {
    const child = spawn(run.command, [...run.args], {
      cwd: run.cwd,
      env: run.env ? { ...process.env, ...run.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', failed);
    child.on('close', (code, signal) => done({
      code: code ?? (signal ? 128 : 1),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') failed(err); });
    if (run.input === undefined) child.stdin.end();
    else child.stdin.end(run.input);
  }),
};

export const nodeStreams: Streams = {
  pipe: (run: ProcessRun, input: NodeJS.ReadableStream) => new Promise<ProcessResult>((done, failed) => {
    const child = spawn(run.command, [...run.args], { cwd: run.cwd, env: run.env ? { ...process.env, ...run.env } : process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', failed);
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') failed(err); });
    input.on('error', (err: Error) => { child.kill(); failed(err); });
    child.on('close', (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    input.pipe(child.stdin);
  }),
  follow: (run: ProcessRun, onOutput: (chunk: string) => void) => {
    const child = spawn(run.command, [...run.args], { cwd: run.cwd, env: run.env ? { ...process.env, ...run.env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const ended = new Promise<ProcessResult>((done, failed) => {
      child.on('error', failed);
      child.on('close', (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout: '', stderr: Buffer.concat(stderr).toString('utf8') }));
    });
    return { stop: () => { child.kill(); }, ended };
  },
};
