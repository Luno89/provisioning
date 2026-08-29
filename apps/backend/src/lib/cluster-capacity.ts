import { vramMibFromNodeLabels } from './gpu-vram.js';

export interface ClusterCapacity {
  cpuCores: number;
  ramGb: number;
  gpuCount?: number;
  gpuVendor?: 'nvidia' | 'amd';
  gpuVramMib?: number;
}

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

const DECIMAL_SUFFIXES: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

export function parseMemoryQuantity(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  const match = /^([0-9.]+(?:[eE][-+]?[0-9]+)?)([EPTGMK]i|[kKMGTPE])?$/.exec(text);
  if (!match || match[1] === undefined) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const suffix = match[2];
  if (!suffix) return value;
  const multiplier = BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix];
  return multiplier === undefined ? undefined : value * multiplier;
}

export function parseCpuQuantity(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  const milli = /^([0-9.]+)m$/.exec(text);
  if (milli && milli[1] !== undefined) {
    const v = Number(milli[1]);
    return Number.isFinite(v) ? v / 1000 : undefined;
  }
  const v = Number(text);
  return Number.isFinite(v) ? v : undefined;
}

interface NodeLike {
  status?: { allocatable?: Record<string, string> };
}

export function capacityFromNodes(payload: unknown): ClusterCapacity | undefined {
  const gpuVramMib = vramMibFromNodeLabels(payload);
  const items = (payload as { items?: NodeLike[] } | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  let cpuCores = 0;
  let ramBytes = 0;
  let gpuCount = 0;
  let gpuVendor: 'nvidia' | 'amd' | undefined;

  for (const node of items) {
    const alloc = node?.status?.allocatable;
    if (!alloc) continue;
    cpuCores = Math.max(cpuCores, parseCpuQuantity(alloc['cpu']) ?? 0);
    ramBytes = Math.max(ramBytes, parseMemoryQuantity(alloc['memory']) ?? 0);

    const nvidia = Number(alloc['nvidia.com/gpu'] ?? 0);
    const amd = Number(alloc['amd.com/gpu'] ?? 0);
    if (Number.isFinite(nvidia) && nvidia > gpuCount) {
      gpuCount = nvidia;
      gpuVendor = 'nvidia';
    }
    if (Number.isFinite(amd) && amd > gpuCount) {
      gpuCount = amd;
      gpuVendor = 'amd';
    }
  }

  if (cpuCores === 0 && ramBytes === 0) return undefined;

  return {
    cpuCores: Math.round(cpuCores * 100) / 100,
    ramGb: Math.round((ramBytes / 1024 ** 3) * 10) / 10,
    ...(gpuCount > 0 ? { gpuCount, ...(gpuVendor ? { gpuVendor } : {}) } : {}),
    ...(gpuVramMib ? { gpuVramMib } : {}),
  };
}

export const APP_RESOURCE_NEEDS: Record<
  string,
  { memory: string; label: string; gpuCountField?: string }
> = {
  vllm: { memory: '6G', label: 'vLLM', gpuCountField: 'vllmGpuCount' },
  tabbyapi: { memory: '6G', label: 'TabbyAPI', gpuCountField: 'tabbyGpuCount' },
};

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

export function requestedGpuCount(appType: string, config: Record<string, unknown>): number {
  const field = APP_RESOURCE_NEEDS[appType]?.gpuCountField;
  if (!field) return 0;
  const n = Number(config[field]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function checkCapacity(
  appType: string,
  capacity: ClusterCapacity | undefined,
  requestedGpus?: number,
): string | undefined {
  if (!capacity) return undefined;

  const need = APP_RESOURCE_NEEDS[appType];
  if (need) {
    const needBytes = parseMemoryQuantity(need.memory);
    const haveBytes = capacity.ramGb * 1024 ** 3;
    if (needBytes !== undefined && haveBytes > 0 && needBytes > haveBytes) {
      const needGb = Math.round((needBytes / 1024 ** 3) * 10) / 10;
      return `${need.label} needs about ${needGb} GiB of RAM but this cluster's largest node has ${capacity.ramGb} GiB allocatable. The pod would stay Pending forever. Use a larger machine, or lower the app's memory limit.`;
    }
  }

  if (requestedGpus && requestedGpus > 0) {
    const available = capacity.gpuCount ?? 0;
    if (available === 0) {
      return `This deployment requests ${requestedGpus} GPU(s) but no GPUs are visible to the scheduler on this cluster. k3d clusters can never expose a GPU; a self-managed node needs the device plugin installed.`;
    }
    if (requestedGpus > available) {
      return `This deployment requests ${requestedGpus} GPU(s) but the largest node on this cluster has ${available}. A pod cannot span nodes, so it would stay Pending.`;
    }
  }

  return undefined;
}
