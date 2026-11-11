export type GpuVendor = 'nvidia' | 'amd';

export const GPU_VENDORS: readonly GpuVendor[] = ['nvidia', 'amd'];

export interface GpuCard {
  vendor: GpuVendor;
  model: string;
  memoryMiB: number;
}

export interface MachineGpu extends GpuCard {
  count: number;
  runtime: boolean;
}

export interface KfdNode {
  properties: string;
}

export const AMD_PCI_VENDOR = 4098;

export const VENDOR_RUNTIME: Record<GpuVendor, string | undefined> = { nvidia: 'nvidia', amd: undefined };

export const NVIDIA_SMI_QUERY = ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'];

export function nvidiaCards(csv: string): GpuCard[] {
  const cards: GpuCard[] = [];
  for (const line of csv.split('\n')) {
    const at = line.lastIndexOf(',');
    if (at < 0) continue;
    const model = line.slice(0, at).trim();
    const memoryMiB = Number(line.slice(at + 1).trim());
    if (!model || !Number.isFinite(memoryMiB) || memoryMiB <= 0) continue;
    cards.push({ vendor: 'nvidia', model, memoryMiB: Math.round(memoryMiB) });
  }
  return cards;
}

const property = (properties: string, name: string): number | undefined => {
  const line = properties.split('\n').find((entry) => entry.trim().split(/\s+/)[0] === name);
  const value = line ? Number(line.trim().split(/\s+/)[1]) : NaN;
  return Number.isFinite(value) ? value : undefined;
};

export const gfxName = (target: number): string =>
  `gfx${Math.floor(target / 10000)}${Math.floor(target / 100) % 100}${(target % 100).toString(16)}`;

export function amdDiscreteCards(nodes: readonly KfdNode[]): GpuCard[] {
  const cards: GpuCard[] = [];
  for (const node of nodes) {
    if (property(node.properties, 'vendor_id') !== AMD_PCI_VENDOR) continue;
    if ((property(node.properties, 'simd_count') ?? 0) <= 0) continue;
    if ((property(node.properties, 'cpu_cores_count') ?? 0) > 0) continue;
    const bytes = property(node.properties, 'local_mem_size') ?? 0;
    if (bytes <= 0) continue;
    const target = property(node.properties, 'gfx_target_version');
    cards.push({ vendor: 'amd', model: target ? `AMD ${gfxName(target)}` : 'AMD GPU', memoryMiB: Math.round(bytes / 1024 / 1024) });
  }
  return cards;
}

export function runtimeHandlersOf(nodes: unknown): string[] {
  const items = (nodes as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const names = new Set<string>();
  for (const node of items) {
    const handlers = (node as { status?: { runtimeHandlers?: unknown } } | undefined)?.status?.runtimeHandlers;
    if (!Array.isArray(handlers)) continue;
    for (const handler of handlers) {
      const name = (handler as { name?: unknown } | undefined)?.name;
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  return [...names];
}

export function groupedGpus(cards: readonly GpuCard[], runtime: (vendor: GpuVendor) => boolean): MachineGpu[] {
  const groups = new Map<string, MachineGpu>();
  for (const card of cards) {
    const key = `${card.vendor}\n${card.model}\n${card.memoryMiB}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { ...card, count: 1, runtime: runtime(card.vendor) });
  }
  return [...groups.values()];
}

export const gpuCountOf = (gpus: readonly MachineGpu[] | undefined, vendor: GpuVendor, usableOnly = true): number =>
  (gpus ?? []).filter((gpu) => gpu.vendor === vendor && (!usableOnly || gpu.runtime)).reduce((sum, gpu) => sum + gpu.count, 0);

export const usableVendors = (gpus: readonly MachineGpu[] | undefined): GpuVendor[] =>
  GPU_VENDORS.filter((vendor) => gpuCountOf(gpus, vendor) > 0);

export interface GpuReport {
  gpus: MachineGpu[];
  problems: string[];
}
