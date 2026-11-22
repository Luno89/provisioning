import type { UpdateSetting } from './instance-updates.js';
import type { SignInKey } from './oidc.js';
import type { KoalaInstallRecord } from './koala-installs.js';
import type { InstanceSetup } from './instance-setup.js';

export type InstanceStatus = 'waiting' | 'joined' | 'installing' | 'ready' | 'failed';

export const INSTANCE_STATUSES: readonly InstanceStatus[] = ['waiting', 'joined', 'installing', 'ready', 'failed'];

export interface ServiceState {
  status?: InstanceStatus | string | undefined;
  servedAt?: string | undefined;
}

export const inService = (instance: ServiceState): boolean =>
  instance.status === undefined
  || instance.status === 'ready'
  || (Boolean(instance.servedAt) && (instance.status === 'installing' || instance.status === 'failed'));

export const servingOf = <T extends ServiceState>(instances: readonly T[]): T | undefined => instances.find(inService);

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
  machine?: string | undefined;
  machineId?: string | undefined;
  name?: string | undefined;
  meshIp?: string | undefined;
  addresses?: InstanceAddresses | undefined;
  groups?: InstanceGroup[] | undefined;
  updates?: UpdateSetting | undefined;
  running?: string | undefined;
  dataVersion?: number | undefined;
  previous?: string | undefined;
  signIn?: SignInKey | undefined;
  install?: KoalaInstallRecord | undefined;
  setup?: InstanceSetup | undefined;
}

export interface InstanceGroup {
  projectId: string;
  name: string;
}

export type NestedState = 'issuing' | 'ready';

export interface InstanceAddresses {
  nested: boolean;
  state?: NestedState | undefined;
  detail?: string | undefined;
}
