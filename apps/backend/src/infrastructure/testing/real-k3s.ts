import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeProcesses, succeeded, type Processes } from '../../platform/index.js';
import type { ServiceAccount } from '../lib/cluster-places.js';

export const K3S_TEST_IMAGE = 'rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657';

const REPO = resolve(import.meta.dirname, '../../../../../');

export const TOOLS = { kubectl: join(REPO, 'bin', 'kubectl'), helm: join(REPO, 'bin', 'helm') };

export interface RealK3s {
  admin: string;
  account: ServiceAccount;
  folder: string;
  stop(): Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function startK3s(processes: Processes = nodeProcesses): Promise<RealK3s> {
  const name = `koala-k3s-test-${randomUUID().slice(0, 8)}`;
  const docker = (...args: string[]): Promise<string> => succeeded(processes, { command: 'docker', args });
  await docker('run', '-d', '--name', name, '--privileged', '-p', '127.0.0.1::6443', K3S_TEST_IMAGE, 'server', '--disable=traefik,servicelb,metrics-server', '--tls-san', '127.0.0.1');
  const stop = async (): Promise<void> => { await docker('rm', '-f', name); };
  try {
    const port = (await docker('port', name, '6443')).split('\n')[0]!.split(':').pop()!.trim();
    while (!/\sReady\s/.test((await processes.run({ command: 'docker', args: ['exec', name, 'kubectl', 'get', 'nodes', '--no-headers'] })).stdout)) await pause(250);
    const folder = mkdtempSync(join(tmpdir(), 'koala-k3s-'));
    const admin = (await docker('exec', name, 'cat', '/etc/rancher/k3s/k3s.yaml')).replace('https://127.0.0.1:6443', `https://127.0.0.1:${port}`);
    const inside = (...args: string[]): Promise<string> => docker('exec', name, 'kubectl', ...args);
    await inside('create', 'serviceaccount', 'koala', '-n', 'default');
    await inside('create', 'clusterrolebinding', 'koala', '--clusterrole=cluster-admin', '--serviceaccount=default:koala');
    const token = (await inside('create', 'token', 'koala', '-n', 'default', '--duration=1h')).trim();
    const ca = Buffer.from(/certificate-authority-data: (\S+)/.exec(admin)![1]!, 'base64').toString('utf8');
    const account: ServiceAccount = { host: '127.0.0.1', port, caFile: join(folder, 'ca.crt'), tokenFile: join(folder, 'token') };
    writeFileSync(account.caFile, ca, { mode: 0o600 });
    writeFileSync(account.tokenFile, token, { mode: 0o600 });
    return { admin, account, folder, stop };
  } catch (failure) {
    await stop();
    throw failure;
  }
}
