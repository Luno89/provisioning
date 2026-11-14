export interface ClusterCapacity {
  cpuCores: number;
  ramGb: number;
  gpuCount?: number;
  gpuVendor?: 'nvidia' | 'amd';
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

export const APP_RESOURCE_NEEDS: Record<
  string,
  { memory: string; label: string }
> = {
  vllm: { memory: '6G', label: 'vLLM' },
  tabbyapi: { memory: '6G', label: 'TabbyAPI' },
};

export class CapacityError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

export function checkCapacity(appType: string, cluster: { name: string; capacity?: ClusterCapacity | undefined }): string | undefined {
  const need = APP_RESOURCE_NEEDS[appType];
  if (!need) return undefined;
  const needBytes = parseMemoryQuantity(need.memory)!;
  const needGb = Math.round((needBytes / 1024 ** 3) * 10) / 10;
  const { capacity } = cluster;
  if (!capacity) return `${need.label} needs about ${needGb} GiB of RAM, and ${cluster.name} has not said how much it has: its agent is from before machines reported their size, or it has not connected since. Once it connects with a current agent, it says.`;
  if (needBytes > capacity.ramGb * 1024 ** 3) {
    return `${need.label} needs about ${needGb} GiB of RAM but ${cluster.name} has ${capacity.ramGb} GiB. The pod would stay Pending forever. Use a larger machine, or lower the app's memory limit.`;
  }
  return undefined;
}
