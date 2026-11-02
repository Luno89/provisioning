import { spawn } from 'node:child_process';
import type { ProcessResult, ProcessRun, Processes } from '../lib/processes.js';

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
    child.stdin.end(run.input ?? '');
  }),
};
