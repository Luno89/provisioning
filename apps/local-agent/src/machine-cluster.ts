import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ignore } from '@koala/engine-core/failures';
import { MACHINE_CLUSTER_ABSENT, MACHINE_OFF_MESH, type MachineClusterOp, type MachineClusterResult } from '@koala/engine-core';

export const K3S_BINARY = '/usr/local/bin/k3s';
export const K3S_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
export const K3S_KILLALL = '/usr/local/bin/k3s-killall.sh';
export const K3S_UNINSTALL = '/usr/local/lib/koala/machine-uninstall.sh';
export const K3S_MARKER = '/etc/koala/machine-k3s';

export interface ClusterHost {
  run(file: string, args: string[]): Promise<string>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  wanted(running: boolean): Promise<void>;
  isWanted(): Promise<boolean>;
  holdKoala(instanceId: string): Promise<void>;
  holdsKoala(): Promise<boolean>;
  meshIp(): Promise<string | undefined>;
  now(): number;
  pause(ms: number): Promise<void>;
}

const execute = promisify(execFile);

export const wantedFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'koala', 'cluster-wanted');

export const koalaHereFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'koala', 'koala-here');

const present = (file: string) => access(file).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });

export const hostCluster = (meshIp: () => Promise<string | undefined>, wantedAt: string = wantedFile(), koalaHere: string = koalaHereFile()): ClusterHost => ({
  run: async (file, args) => (await execute(file, args, { maxBuffer: 16 * 1024 * 1024 })).stdout,
  exists: (path) => access(path).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; }),
  read: (path) => readFile(path, 'utf8'),
  wanted: async (running) => {
    if (!running) return rm(wantedAt, { force: true });
    await mkdir(path.dirname(wantedAt), { recursive: true });
    await writeFile(wantedAt, `${new Date().toISOString()}\n`);
  },
  isWanted: () => present(wantedAt),
  holdKoala: async (instanceId) => {
    await mkdir(path.dirname(koalaHere), { recursive: true });
    await writeFile(koalaHere, `${instanceId}\n`);
  },
  holdsKoala: () => present(koalaHere),
  meshIp: () => meshIp(),
  now: () => Date.now(),
  pause: async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) await new Promise((done) => setTimeout(done, until - Date.now()));
  },
});

const kubectl = (host: ClusterHost, args: string[]) => host.run(K3S_BINARY, ['kubectl', '--kubeconfig', K3S_KUBECONFIG, ...args]);

const STARTING = 'while k3s starts its API refuses kubectl, which is what starting looks like; the loop asks again';

const DNS_READY = '{.items[0].status.conditions[?(@.type=="Ready")].status} {.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}';
const NODE_READY = '{.items[0].status.conditions[?(@.type=="Ready")].status} {.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}';

export const readySince = (answer: string, since: number): boolean => {
  const [status, at] = answer.trim().split(' ');
  return status === 'True' && Boolean(at) && Date.parse(at!) >= since;
};

export const kubeconfigOnMesh = (kubeconfig: string, meshIp: string): string =>
  kubeconfig.replace(/server:\s*https:\/\/(127\.0\.0\.1|localhost|\[::1\]):6443/g, `server: https://${meshIp}:6443`);

async function unitFailed(host: ClusterHost): Promise<string | undefined> {
  const state = (await host.run('systemctl', ['show', 'k3s', '--property=ActiveState', '--value'])).trim();
  if (state !== 'failed') return undefined;
  return (await host.run('systemctl', ['status', 'k3s', '--no-pager', '--lines=30']).catch((err: Error & { stdout?: string }) => err.stdout ?? err.message)).trim();
}

async function readyAfter(host: ClusterHost, since: number): Promise<void> {
  for (;;) {
    const node = await kubectl(host, ['get', 'nodes', '-o', `jsonpath=${NODE_READY}`]).catch(ignore(STARTING)) ?? '';
    const dns = await kubectl(host, ['-n', 'kube-system', 'get', 'pod', '-l', 'k8s-app=kube-dns', '-o', `jsonpath=${DNS_READY}`]).catch(ignore(STARTING)) ?? '';
    if (readySince(node, since) && readySince(dns, since)) return;
    const failed = await unitFailed(host);
    if (failed) throw new Error(`k3s stopped while it started on this machine:\n${failed}`);
    await host.pause(2000);
  }
}

export async function clusterState(host: ClusterHost): Promise<'absent' | 'stopped' | 'running'> {
  if (!await host.exists(K3S_MARKER)) return 'absent';
  const state = (await host.run('systemctl', ['show', 'k3s', '--property=ActiveState', '--value'])).trim();
  return state === 'active' || state === 'activating' ? 'running' : 'stopped';
}

export async function runMachineCluster(host: ClusterHost, op: MachineClusterOp): Promise<MachineClusterResult> {
  if (!await host.exists(K3S_MARKER)) {
    if (op.kind === 'stop') return { state: 'absent' };
    throw new Error(MACHINE_CLUSTER_ABSENT);
  }
  if (op.kind === 'stop' && !await host.holdsKoala()) {
    await host.run('sudo', ['-n', 'systemctl', 'stop', 'k3s']);
    await host.run('sudo', ['-n', K3S_KILLALL]);
    await host.wanted(false);
    return { state: 'stopped' };
  }
  const meshIp = await host.meshIp();
  if (!meshIp) throw new Error(MACHINE_OFF_MESH);
  const running = await clusterState(host) === 'running';
  const since = running ? 0 : host.now() - 1000;
  await host.wanted(true);
  if (!running) await host.run('sudo', ['-n', 'systemctl', 'start', 'k3s']);
  await readyAfter(host, since);
  return { state: 'running', meshIp, kubeconfig: kubeconfigOnMesh(await host.read(K3S_KUBECONFIG), meshIp) };
}

export async function startIfWanted(host: ClusterHost, log: (line: string) => void): Promise<void> {
  if (!await host.isWanted() || await clusterState(host) !== 'stopped') return;
  log('this machine\'s cluster was running before it stopped, so it starts again for the apps on it');
  await runMachineCluster(host, { kind: 'start' });
  log('this machine\'s cluster is running again');
}

export async function clusterOnConnect(host: ClusterHost, log: (line: string) => void): Promise<'absent' | 'stopped' | 'running'> {
  await startIfWanted(host, log).catch((err: Error) => log(`this machine's cluster could not start again: ${err.message}`));
  return clusterState(host);
}

export async function uninstallMachineCluster(host: ClusterHost, log: (line: string) => void): Promise<void> {
  if (!await host.exists(K3S_UNINSTALL)) return;
  await host.wanted(false);
  await host.run('sudo', ['-n', K3S_UNINSTALL]).then(
    () => log('k3s and everything Koala ran on it are removed from this machine'),
    (err: Error) => log(`k3s could not be removed from this machine: ${err.message}`),
  );
}
