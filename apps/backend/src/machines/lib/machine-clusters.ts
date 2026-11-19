import { GPU_VENDORS, gpuCountOf, type GpuReport, type GpuVendor, type GpuWithoutDriver, type MachineCapacity, type MachineGpu } from '@koala/engine-core';
import type { ClusterMetadata, DeploymentMetadata, LocalAgentDeviceMetadata } from '../../platform/index.js';
import { machineClusterId } from '../../infrastructure/lib/cluster-name.js';

export type ReportedClusterState = 'absent' | 'stopped' | 'running';

export { machineClusterId };

export const reportedClusterState = (raw: unknown): ReportedClusterState | undefined => {
  const state = (raw as { state?: unknown } | undefined)?.state;
  return state === 'absent' || state === 'stopped' || state === 'running' ? state : undefined;
};

export const MOST_GPUS_OF_A_KIND = 64;
const MOST_PROBLEMS = 8;
const LONGEST_PROBLEM = 500;

const keptGpu = (raw: unknown): MachineGpu | undefined => {
  const gpu = raw as Partial<Record<keyof MachineGpu, unknown>> | undefined;
  if (!gpu || !GPU_VENDORS.includes(gpu.vendor as GpuVendor)) return undefined;
  const model = typeof gpu.model === 'string' ? gpu.model.trim().slice(0, 120) : '';
  const { memoryMiB, count } = gpu;
  if (!model || typeof memoryMiB !== 'number' || !Number.isInteger(memoryMiB) || memoryMiB <= 0) return undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || count > MOST_GPUS_OF_A_KIND) return undefined;
  if (typeof gpu.runtime !== 'boolean') return undefined;
  return { vendor: gpu.vendor as GpuVendor, model, memoryMiB, count, runtime: gpu.runtime };
};

export const reportedGpus = (raw: unknown): MachineGpu[] | undefined =>
  Array.isArray(raw) ? raw.map(keptGpu).filter((gpu): gpu is MachineGpu => Boolean(gpu)) : undefined;

const keptWithoutDriver = (raw: unknown): GpuWithoutDriver | undefined => {
  const gpu = raw as Partial<Record<keyof GpuWithoutDriver, unknown>> | undefined;
  if (!gpu || typeof gpu !== 'object' || !GPU_VENDORS.includes(gpu.vendor as GpuVendor)) return undefined;
  const device = typeof gpu.device === 'string' ? gpu.device.trim().slice(0, 120) : '';
  const { count } = gpu;
  if (!device || typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || count > MOST_GPUS_OF_A_KIND) return undefined;
  return { vendor: gpu.vendor as GpuVendor, device, count };
};

const reportedWithoutDriver = (raw: unknown): GpuWithoutDriver[] =>
  (Array.isArray(raw) ? raw : []).map(keptWithoutDriver).filter((gpu): gpu is GpuWithoutDriver => Boolean(gpu));

const reportedProblems = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).filter((line): line is string => typeof line === 'string' && line.trim() !== '').map((line) => line.trim().slice(0, LONGEST_PROBLEM)).slice(0, MOST_PROBLEMS);

export interface ReportedCluster {
  state: ReportedClusterState;
  gpus?: GpuReport | undefined;
  capacity?: MachineCapacity | undefined;
}

const wholeAboveNothing = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

const reportedCapacity = (raw: unknown): MachineCapacity | undefined => {
  const capacity = raw as Partial<Record<keyof MachineCapacity, unknown>> | undefined;
  return capacity && typeof capacity === 'object' && wholeAboveNothing(capacity.cpuCores) && wholeAboveNothing(capacity.memoryMiB)
    ? { cpuCores: capacity.cpuCores, memoryMiB: capacity.memoryMiB }
    : undefined;
};

export const reportedCluster = (raw: unknown): ReportedCluster | undefined => {
  const state = reportedClusterState(raw);
  if (!state) return undefined;
  const gpus = reportedGpus((raw as { gpus?: unknown }).gpus);
  const capacity = reportedCapacity((raw as { capacity?: unknown }).capacity);
  return {
    state,
    ...(gpus ? { gpus: { gpus, problems: reportedProblems((raw as { problems?: unknown }).problems), withoutDriver: reportedWithoutDriver((raw as { withoutDriver?: unknown }).withoutDriver) } } : {}),
    ...(capacity ? { capacity } : {}),
  };
};

export function clusterCapacityOf(capacity: MachineCapacity, gpus: readonly MachineGpu[] | undefined): NonNullable<ClusterMetadata['capacity']> {
  const most = GPU_VENDORS.map((vendor) => ({ vendor, count: gpuCountOf(gpus, vendor) })).reduce((best, next) => (next.count > best.count ? next : best), { vendor: 'nvidia' as GpuVendor, count: 0 });
  return {
    cpuCores: capacity.cpuCores,
    ramGb: Math.floor((capacity.memoryMiB / 1024) * 10) / 10,
    ...(most.count > 0 ? { gpuCount: most.count, gpuVendor: most.vendor } : {}),
  };
}

export const newMachineCluster = (device: Pick<LocalAgentDeviceMetadata, 'id' | 'ownerId' | 'name' | 'meshIp'>, at: string): ClusterMetadata => ({
  id: machineClusterId(device.id),
  name: device.name,
  provider: 'machine',
  status: 'stopped',
  machineId: device.id,
  ownerId: device.ownerId,
  createdAt: at,
  ...(device.meshIp ? { meshIp: device.meshIp } : {}),
});

export const appsOn = (deployments: readonly DeploymentMetadata[], clusterId: string, leaving?: string): DeploymentMetadata[] =>
  deployments.filter((deployment) => deployment.clusterId === clusterId && deployment.id !== leaving);
