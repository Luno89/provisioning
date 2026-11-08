import type { ClusterMetadata } from '../../platform/index.js';
import type { MachineOfCluster } from './app-destroy.js';
import { machineClusterId, SYSTEM_CLUSTER_ID } from './cluster-name.js';

export const ROOT_CLUSTER_ID = 'root';

export type ClusterPlace =
  | { kind: 'koala'; clusterId: string }
  | { kind: 'machine'; clusterId: string; sealed: string }
  | { kind: 'root'; clusterId: string };

export type WhyUnreachable = 'unknown' | 'stopped' | 'not-started' | 'other-kind' | 'not-root' | 'no-account' | 'no-key' | 'not-configured' | 'no-records';

export type Reach =
  | { clusterId: string; kind: 'koala' }
  | { clusterId: string; kind: 'machine'; kubeconfig: string }
  | { clusterId: string; kind: 'root' };

export const startedMachine = (clusterId: string, kubeconfig: string): Reach => ({ clusterId, kind: 'machine', kubeconfig });

export type HandOver =
  | { clusterId: string; machine: MachineOfCluster }
  | { clusterId: string; reach: Reach };

export interface Unreachable { kind: 'unreachable'; clusterId: string; why: WhyUnreachable; reason: string }

export interface Here {
  koalaMachineId?: string | undefined;
  root: boolean;
}

export type KnownCluster = Pick<ClusterMetadata, 'id' | 'name' | 'provider' | 'machineId' | 'status' | 'kubeconfigEnc'>;

const unreachable = (clusterId: string, why: WhyUnreachable, reason: string): Unreachable => ({ kind: 'unreachable', clusterId, why, reason });

export const koalasClusterId = (here: Here): string | undefined =>
  here.root ? undefined : here.koalaMachineId ? machineClusterId(here.koalaMachineId) : SYSTEM_CLUSTER_ID;

export const ownReach = (here: Here): Reach =>
  here.root ? { clusterId: ROOT_CLUSTER_ID, kind: 'root' } : { clusterId: koalasClusterId(here)!, kind: 'koala' };

export function machineToStart(clusterId: string, cluster: KnownCluster | undefined, here: Here): MachineOfCluster | undefined {
  if (cluster?.provider === 'machine' && cluster.machineId) return { deviceId: cluster.machineId };
  if (here.koalaMachineId && clusterId === machineClusterId(here.koalaMachineId)) return { deviceId: here.koalaMachineId };
  return undefined;
}

export function placeOf(clusterId: string, cluster: KnownCluster | undefined, here: Here): ClusterPlace | Unreachable {
  if (clusterId === ROOT_CLUSTER_ID) {
    return here.root ? { kind: 'root', clusterId } : unreachable(clusterId, 'not-root', 'only root reaches root\'s own cluster');
  }
  if (clusterId === koalasClusterId(here)) return { kind: 'koala', clusterId };
  if (!cluster) return unreachable(clusterId, 'unknown', `there is no cluster ${clusterId}`);
  if (cluster.provider !== 'machine') return unreachable(clusterId, 'other-kind', `${cluster.name} is a ${cluster.provider} cluster, and every cluster Koala reaches is a machine's`);
  if (here.koalaMachineId && cluster.machineId === here.koalaMachineId) return { kind: 'koala', clusterId };
  if (cluster.status === 'stopped') return unreachable(clusterId, 'stopped', `${cluster.name} is stopped until something runs on it`);
  if (!cluster.kubeconfigEnc) return unreachable(clusterId, 'not-started', `${cluster.name} has not started yet, so there is no way to reach it`);
  return { kind: 'machine', clusterId, sealed: cluster.kubeconfigEnc };
}

export interface ServiceAccount {
  host: string;
  port: string;
  caFile: string;
  tokenFile: string;
}

export function serviceAccountFrom(env: Readonly<Record<string, string | undefined>>, folder: string): ServiceAccount | undefined {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim();
  if (!host || !port) return undefined;
  return { host, port, caFile: `${folder}/ca.crt`, tokenFile: `${folder}/token` };
}

const server = (account: ServiceAccount): string => `https://${account.host.includes(':') ? `[${account.host}]` : account.host}:${account.port}`;

export function serviceAccountKubeconfig(account: ServiceAccount): string {
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: koala',
    '  cluster:',
    `    server: ${server(account)}`,
    `    certificate-authority: ${account.caFile}`,
    'users:',
    '- name: koala',
    '  user:',
    `    tokenFile: ${account.tokenFile}`,
    'contexts:',
    '- name: koala',
    '  context:',
    '    cluster: koala',
    '    user: koala',
    'current-context: koala',
    '',
  ].join('\n');
}
