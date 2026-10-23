import type { PoolPorts } from './pool.js';
import type { TrialStep } from './pool-trial.js';
import type { InstanceMove } from './instance-move.js';

export type InstanceStatus = 'waiting' | 'joined' | 'installing' | 'ready' | 'failed' | 'paused';

export const INSTANCE_STATUSES: readonly InstanceStatus[] = ['waiting', 'joined', 'installing', 'ready', 'failed'];

export interface ServiceState {
  status?: InstanceStatus | string | undefined;
  servedAt?: string | undefined;
}

export const inService = (instance: ServiceState): boolean =>
  instance.status === undefined
  || instance.status === 'ready'
  || (Boolean(instance.servedAt) && (instance.status === 'installing' || instance.status === 'failed'));

export const stampServed = <T extends ServiceState & { updatedAt: string }>(instance: T): T & { servedAt?: string | undefined } =>
  instance.status === 'ready' && !instance.servedAt ? { ...instance, servedAt: instance.updatedAt } : instance;

export interface InstanceRecord {
  id: string;
  ownerId: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  status?: InstanceStatus | undefined;
  detail?: string | undefined;
  servedAt?: string | undefined;
  credentialHash?: string | undefined;
  machine?: string | undefined;
  name?: string | undefined;
  meshIp?: string | undefined;
  addresses?: InstanceAddresses | undefined;
  pool?: InstancePool | undefined;
  move?: InstanceMove | undefined;
  groups?: InstanceGroup[] | undefined;
}

export interface InstanceGroup {
  projectId: string;
  name: string;
}

export interface InstancePool {
  ports: PoolPorts;
  startedAt: string;
  trialEndsAt: string;
  told?: TrialStep[] | undefined;
  pausedAt?: string | undefined;
}

export type NestedState = 'issuing' | 'ready';

export interface InstanceAddresses {
  nested: boolean;
  state?: NestedState | undefined;
  detail?: string | undefined;
}

export interface JoinToken {
  hash: string;
  ownerId: string;
  instanceId: string;
  expiresAt: string;
  move?: boolean | undefined;
}

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function instanceProblem(candidate: { id: string; ownerId: string; url: string }): string | null {
  if (!ID.test(candidate.id)) return 'an instance id is lower-case letters, digits and dashes';
  if (!candidate.ownerId.trim()) return 'an instance needs an owner';
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return `"${candidate.url}" is not a URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'an instance is reached over http or https';
  if (url.pathname !== '/' || url.search || url.hash) return 'an instance URL is an origin, with no path';
  return null;
}
