import { childEnv } from './child-env.js';
import { spawn } from 'node:child_process';
import type { Followed, Io, ProcessResult, ProcessRun, Processes, Streams } from '../lib/processes.js';

export const nodeProcesses: Processes = {
  run: (run: ProcessRun) => new Promise<ProcessResult>((done, failed) => {
    const child = spawn(run.command, [...run.args], {
      cwd: run.cwd,
      env: childEnv(run.env),
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
    const child = spawn(run.command, [...run.args], { cwd: run.cwd, env: childEnv(run.env), stdio: ['pipe', 'pipe', 'pipe'] });
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
    const child = spawn(run.command, [...run.args], { cwd: run.cwd, env: childEnv(run.env), stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onOutput(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const ended = new Promise<ProcessResult>((done, failed) => {
      child.on('error', failed);
      child.on('close', (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout: '', stderr: Buffer.concat(stderr).toString('utf8') }));
    });
    return { stop: () => { child.kill(); }, ended };
  },
  start: (run: ProcessRun, io: Io = {}): Followed => {
    const child = spawn(run.command, [...run.args], { cwd: run.cwd, env: childEnv(run.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failed: (err: Error) => void = () => undefined;
    const closed = new Promise<number>((done, fail) => {
      failed = fail;
      child.on('error', fail);
      child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
    });
    const { output } = io;
    const written = output
      ? new Promise<void>((done, fail) => { output.on('finish', done); output.on('error', fail); })
      : Promise.resolve();
    if (output) child.stdout.pipe(output);
    else child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') failed(err); });
    const input = io.input ?? run.input;
    if (input === undefined) child.stdin.end();
    else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
    else {
      input.on('error', (err: Error) => { child.kill('SIGKILL'); failed(err); });
      input.pipe(child.stdin);
    }
    const ended = Promise.all([closed, written]).then(([code]) => ({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    return { stop: () => { child.kill('SIGKILL'); }, ended };
  },
};
