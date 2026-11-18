import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeProcesses, succeeded, type Processes } from '../../platform/index.js';
import type { ServiceAccount } from '../lib/cluster-places.js';
import { removeThrowaway, throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';
import { ensureImageCaches, IMAGE_CACHES, imageCacheContainer } from './image-caches.js';

export const K3S_TEST_IMAGE = 'rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657';

const REPO = resolve(import.meta.dirname, '../../../../../');

export const TOOLS = { kubectl: join(REPO, 'bin', 'kubectl'), helm: join(REPO, 'bin', 'helm') };

declare module 'vitest' {
  export interface ProvidedContext {
    k3s: { admin: string; account: ServiceAccount };
  }
}

export interface RealK3s {
  admin: string;
  account: ServiceAccount;
  folder: string;
  stop(): Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function mirrorsThroughCaches(processes: Processes): Promise<string> {
  await ensureImageCaches();
  const lines = ['mirrors:'];
  for (const cache of IMAGE_CACHES) {
    const address = (await succeeded(processes, { command: 'docker', args: ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', imageCacheContainer(cache.registry)] })).trim();
    if (!address) throw new Error(`the image cache for ${cache.registry} has no address on Docker's network`);
    lines.push(`  "${cache.registry}":`, '    endpoint:', `      - "http://${address}:5000"`);
  }
  const file = join(mkdtempSync(join(tmpdir(), 'koala-k3s-registries-')), 'registries.yaml');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export async function startK3s(processes: Processes = nodeProcesses): Promise<RealK3s> {
  const name = `koala-k3s-test-${randomUUID().slice(0, 8)}`;
  const docker = (...args: string[]): Promise<string> => succeeded(processes, { command: 'docker', args });
  const registries = await mirrorsThroughCaches(processes);
  await docker('run', '-d', '--name', name, ...throwawayLabel(), '--privileged', '-p', '127.0.0.1::6443', '-v', `${registries}:/etc/rancher/k3s/registries.yaml:ro`, K3S_TEST_IMAGE, 'server', '--disable=traefik,servicelb,metrics-server', '--tls-san', '127.0.0.1');
  const stop = (): Promise<void> => removeThrowaway(name, (args) => docker(...args));
  const stillRunning = async (what: string): Promise<void> => {
    if ((await docker('inspect', '-f', '{{.State.Running}}', name)).trim() === 'true') return;
    const said = await processes.run({ command: 'docker', args: ['logs', '--tail', '20', name] });
    throw new Error(`the throwaway k3s ${name} stopped while ${what}:\n${said.stdout}${said.stderr}`);
  };
  try {
    const port = (await docker('port', name, '6443')).split('\n')[0]!.split(':').pop()!.trim();
    const folder = mkdtempSync(join(tmpdir(), 'koala-k3s-'));
    const written = join(folder, 'k3s.yaml');
    while ((await processes.run({ command: 'docker', args: ['cp', `${name}:/etc/rancher/k3s/k3s.yaml`, written] })).code !== 0) {
      await stillRunning('writing its kubeconfig');
      await pause(250);
    }
    const admin = readFileSync(written, 'utf8').replace('https://127.0.0.1:6443', `https://127.0.0.1:${port}`);
    const adminFile = join(folder, 'admin.yaml');
    writeFileSync(adminFile, admin, { mode: 0o600 });
    const outside = (...args: string[]) => processes.run({ command: TOOLS.kubectl, args: ['--kubeconfig', adminFile, ...args] });
    while (!/\sReady\s/.test((await outside('get', 'nodes', '--no-headers')).stdout)) {
      await stillRunning('starting');
      await pause(250);
    }
    while ((await outside('get', 'serviceaccount', 'default', '-n', 'default')).code !== 0) {
      await stillRunning('making its default service account');
      await pause(250);
    }
    const applied = async (): Promise<boolean> => {
      const manifests = (await docker('exec', name, 'ls', '/var/lib/rancher/k3s/server/manifests')).split('\n').filter((file) => file.endsWith('.yaml'));
      if (manifests.includes('traefik.yaml')) return false;
      const events = (await outside('get', 'events', '-n', 'kube-system', '--field-selector', 'involvedObject.kind=Addon,reason=AppliedManifest', '-o', 'jsonpath={range .items[*]}{.involvedObject.name}{"\\n"}{end}')).stdout.split('\n');
      return manifests.every((file) => events.includes(file.replace(/\.yaml$/, '')));
    };
    while (!(await applied())) {
      await stillRunning('applying its own add-ons');
      await pause(250);
    }
    const inside = (...args: string[]): Promise<string> => succeeded(processes, { command: TOOLS.kubectl, args: ['--kubeconfig', adminFile, ...args] });
    await inside('wait', '--for=condition=Available', 'deployment', '--all', '-n', 'kube-system', '--timeout=720h');
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
