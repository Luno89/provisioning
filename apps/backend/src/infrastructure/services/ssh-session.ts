import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcesses, type Processes } from '../../platform/index.js';

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

export function runScriptOverSsh(target: SshTarget, script: string, onLine: (line: string) => void, processes: Processes = nodeProcesses): Promise<number> {
  return withKey(target.privateKey, async (keyPath) => {
    const lines = (): { push(chunk: string): void; end(): void } => {
      let pending = '';
      return {
        push(chunk) {
          pending += chunk;
          const complete = pending.split('\n');
          pending = complete.pop() ?? '';
          for (const line of complete) onLine(line.replace(/\r$/, ''));
        },
        end() {
          if (pending) onLine(pending);
          pending = '';
        },
      };
    };
    const out = lines();
    const err = lines();
    const ran = await processes.run({ command: 'ssh', args: [...sshArgs(target, keyPath), 'bash -s'], input: script }, { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) });
    out.end();
    err.end();
    return ran.signal !== undefined ? 1 : ran.code;
  });
}

export async function sshAnswers(target: SshTarget, processes: Processes = nodeProcesses): Promise<boolean> {
  return (await runScriptOverSsh(target, 'true', () => undefined, processes)) === 0;
}

export async function readOverSsh(target: SshTarget, command: string, processes: Processes = nodeProcesses): Promise<string> {
  const lines: string[] = [];
  const code = await runScriptOverSsh(target, command, (line) => lines.push(line), processes);
  if (code !== 0) throw new Error(`${command.split(' ')[0]} on ${target.host} ended with ${code}`);
  return lines.join('\n');
}
