import { passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { nodeProcesses, nodeStreams } from '@koala/engine-core/node-processes';
import { ProcessFailed, succeeded, type Processes, type Streams } from '@koala/engine-core/processes';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allReporters, k3sStep, runSteps, type ChartCluster, type Provider, type ServiceContext, type Watch } from '@koala/provision';
import { MACHINE_CLUSTER_ABSENT, MACHINE_OFF_MESH, type MachineClusterOp, type MachineClusterResult } from '@koala/engine-core';
import type { GpuProbe } from './machine-gpus.js';
import { configFile, metricsClientFile } from './machine-config.js';

export const K3S_BINARY = '/usr/local/bin/k3s';
export const K3S_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
export const K3S_KILLALL = '/usr/local/bin/k3s-killall.sh';
export const K3S_UNINSTALL = '/usr/local/lib/koala/machine-uninstall.sh';
export const K3S_MARKER = '/etc/koala/machine-k3s';

export interface ClusterHost extends GpuProbe {
  run(file: string, args: string[]): Promise<string>;
  follow(file: string, args: string[], heard: (chunk: string) => void): Promise<Watch>;
  wanted(running: boolean): Promise<void>;
  isWanted(): Promise<boolean>;
  holdKoala(instanceId: string, installId: string, readyAt?: string): Promise<void>;
  holdsKoala(): Promise<boolean>;
  heldKoala(): Promise<KoalaHeld | undefined>;
  letKoalaGo(): Promise<void>;
  meshIp(): Promise<string | undefined>;
  now(): number;
  pause(ms: number): Promise<void>;
}

export interface MachineHost extends ClusterHost {
  metricsClient(): Promise<string | undefined>;
}

export const METRICS_CLIENT_MISSING = 'this machine holds no sign-in at root for its Prometheus, so its cluster could not send its metrics: run the command from My Machines again';

export interface KoalaHeld {
  instanceId: string;
  installId?: string | undefined;
  readyAt?: string | undefined;
}

export function koalaHeldOf(text: string): KoalaHeld | undefined {
  const [instanceId, installId, readyAt] = text.trim().split(/\s+/);
  return instanceId ? { instanceId, ...(installId ? { installId } : {}), ...(installId && readyAt ? { readyAt } : {}) } : undefined;
}


export const wantedFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'koala', 'cluster-wanted');

export const koalaHereFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'koala', 'koala-here');

const present = (file: string) => access(file).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });

export const onMachine = (machineRoot: string) => (file: string): string => (machineRoot === '/' || !path.isAbsolute(file) ? file : path.join(machineRoot, file));

export const hostCluster = (meshIp: () => Promise<string | undefined>, { wantedAt = wantedFile(), koalaHere = koalaHereFile(), metricsClientAt = metricsClientFile(configFile()), machineRoot = '/', processes = nodeProcesses, streams = nodeStreams }: { wantedAt?: string; koalaHere?: string; metricsClientAt?: string; machineRoot?: string; processes?: Processes; streams?: Streams } = {}): MachineHost => {
  const at = onMachine(machineRoot);
  return {
  platform: process.platform,
  run: (file, args) => succeeded(processes, { command: at(file), args: args.map(at), env: passedOn(PERSON_SESSION) }),
  follow: async (file, args, heard) => {
    const followed = streams.follow({ command: at(file), args: args.map(at), env: passedOn(PERSON_SESSION) }, heard);
    return { stop: () => followed.stop(), ended: followed.ended.then(({ code, stderr }) => ({ code, stderr })) };
  },
  exists: (file) => access(at(file)).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; }),
  read: (file) => readFile(at(file), 'utf8'),
  list: (dir) => readdir(at(dir)),
  wanted: async (running) => {
    if (!running) return rm(wantedAt, { force: true });
    await mkdir(path.dirname(wantedAt), { recursive: true });
    await writeFile(wantedAt, `${new Date().toISOString()}\n`);
  },
  isWanted: () => present(wantedAt),
  holdKoala: async (instanceId, installId, readyAt) => {
    await mkdir(path.dirname(koalaHere), { recursive: true });
    await writeFile(koalaHere, `${[instanceId, installId, ...(readyAt ? [readyAt] : [])].join(' ')}\n`);
  },
  holdsKoala: () => present(koalaHere),
  heldKoala: async () => (await present(koalaHere) ? koalaHeldOf(await readFile(koalaHere, 'utf8')) : undefined),
  letKoalaGo: () => rm(koalaHere, { force: true }),
  meshIp: () => meshIp(),
  metricsClient: async () => (await present(metricsClientAt) ? metricsClientAt : undefined),
  now: () => Date.now(),
  pause: async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) await new Promise((done) => setTimeout(done, until - Date.now()));
  },
  };
};

const kubectl = (host: ClusterHost, args: string[]) => host.run(K3S_BINARY, ['kubectl', '--kubeconfig', K3S_KUBECONFIG, ...args]);

export const machineChartCluster = (host: ClusterHost, helm: string): ChartCluster => ({
  helm: (args) => host.run(helm, [...args, '--kubeconfig', K3S_KUBECONFIG]),
  kubectl: (args) => kubectl(host, [...args]),
  watch: (path, heard) => host.follow(K3S_BINARY, ['kubectl', '--kubeconfig', K3S_KUBECONFIG, 'get', `--raw=${path}`], heard),
});

export const stoppedPause = (pause: (ms: number) => Promise<void>, stop: AbortSignal) => async (ms: number): Promise<void> => {
  stop.throwIfAborted();
  let quit = (): void => undefined;
  const stopped = new Promise<never>((_, refuse) => {
    quit = () => refuse(stop.reason);
    stop.addEventListener('abort', quit, { once: true });
  });
  try {
    await Promise.race([pause(ms), stopped]);
  } finally {
    stop.removeEventListener('abort', quit);
  }
};

export function stoppableHost(host: MachineHost, stop: AbortSignal): MachineHost {
  return {
    platform: host.platform,
    run: async (file, args) => {
      stop.throwIfAborted();
      return host.run(file, args);
    },
    follow: async (file, args, heard) => {
      stop.throwIfAborted();
      const watch = await host.follow(file, args, heard);
      const quit = (): void => watch.stop();
      stop.addEventListener('abort', quit, { once: true });
      void watch.ended.finally(() => stop.removeEventListener('abort', quit));
      if (stop.aborted) watch.stop();
      return watch;
    },
    exists: (file) => host.exists(file),
    read: (file) => host.read(file),
    list: (dir) => host.list(dir),
    wanted: (running) => host.wanted(running),
    isWanted: () => host.isWanted(),
    holdKoala: (instanceId, installId, readyAt) => host.holdKoala(instanceId, installId, readyAt),
    holdsKoala: () => host.holdsKoala(),
    heldKoala: () => host.heldKoala(),
    letKoalaGo: () => host.letKoalaGo(),
    meshIp: () => host.meshIp(),
    metricsClient: () => host.metricsClient(),
    now: () => host.now(),
    pause: stoppedPause((ms) => host.pause(ms), stop),
  };
}

export { readySince } from '@koala/provision';

export const kubeconfigOnMesh = (kubeconfig: string, meshIp: string): string =>
  kubeconfig.replace(/server:\s*https:\/\/(127\.0\.0\.1|localhost|\[::1\]):6443/g, `server: https://${meshIp}:6443`);

async function unitFailed(host: ClusterHost): Promise<string | undefined> {
  const state = (await host.run('systemctl', ['show', 'k3s', '--property=ActiveState', '--value'])).trim();
  if (state !== 'failed') return undefined;
  return (await host.run('systemctl', ['status', 'k3s', '--no-pager', '--lines=30']).catch((err: Error) => (err instanceof ProcessFailed ? err.result.stdout : err.message))).trim();
}

function machineK3s(host: ClusterHost): Provider<ServiceContext> {
  return {
    running: async () => (await clusterState(host) === 'running' ? { done: true } : { done: false, why: 'k3s is not running on this machine' }),
    async start() {
      if (await clusterState(host) !== 'running') await host.run('sudo', ['-n', 'systemctl', 'start', 'k3s']);
    },
    async ended() {
      const failed = await unitFailed(host);
      return failed ? `k3s stopped while it started on this machine:\n${failed}` : undefined;
    },
  };
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
  await runSteps([k3sStep(machineK3s(host), (args) => kubectl(host, [...args]), () => since)], { wait: { pause: host.pause } }, allReporters());
  return { state: 'running', meshIp, kubeconfig: kubeconfigOnMesh(await host.read(K3S_KUBECONFIG), meshIp) };
}

async function heldMetricsClient(host: MachineHost): Promise<string> {
  const metricsClient = await host.metricsClient();
  if (!metricsClient) throw new Error(METRICS_CLIENT_MISSING);
  return metricsClient;
}

export async function machineClusterOp(host: MachineHost, op: MachineClusterOp): Promise<MachineClusterResult> {
  if (op.kind === 'stop' || !await host.exists(K3S_MARKER)) return runMachineCluster(host, op);
  const metricsClient = await heldMetricsClient(host);
  const result = await runMachineCluster(host, op);
  await kubectl(host, ['apply', '-f', metricsClient]);
  return result;
}

export async function metricsClientInto(host: MachineHost): Promise<void> {
  if (await clusterState(host) !== 'running') return;
  await kubectl(host, ['apply', '-f', await heldMetricsClient(host)]);
}

export async function startIfWanted(host: MachineHost, log: (line: string) => void): Promise<void> {
  if (!await host.isWanted() || await clusterState(host) !== 'stopped') return;
  log('this machine\'s cluster was running before it stopped, so it starts again for the apps on it');
  await machineClusterOp(host, { kind: 'start' });
  log('this machine\'s cluster is running again');
}

export async function clusterOnConnect(host: MachineHost, log: (line: string) => void): Promise<'absent' | 'stopped' | 'running'> {
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
