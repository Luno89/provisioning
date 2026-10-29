import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SshTarget {
  host: string;
  privateKey: string;
  user?: string;
  port?: number;
}

async function withKey<T>(privateKey: string, work: (keyPath: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'koala-ssh-'));
  const keyPath = join(folder, 'id_ed25519');
  await writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  try {
    return await work(keyPath);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const sshArgs = (target: SshTarget, keyPath: string): string[] => [
  '-i', keyPath,
  '-p', String(target.port ?? 22),
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=30',
  `${target.user ?? 'root'}@${target.host}`,
];

export function runScriptOverSsh(target: SshTarget, script: string, onLine: (line: string) => void): Promise<number> {
  return withKey(target.privateKey, (keyPath) => new Promise<number>((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(target, keyPath), 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    const take = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line.replace(/\r$/, ''));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending) onLine(pending);
      resolve(code ?? 1);
    });
    child.stdin.end(script);
  }));
}

export async function sshAnswers(target: SshTarget): Promise<boolean> {
  return (await runScriptOverSsh(target, 'true', () => undefined).catch(() => 255)) === 0;
}

export async function readOverSsh(target: SshTarget, command: string): Promise<string> {
  const lines: string[] = [];
  const code = await runScriptOverSsh(target, command, (line) => lines.push(line));
  if (code !== 0) throw new Error(`${command.split(' ')[0]} on ${target.host} ended with ${code}`);
  return lines.join('\n');
}
