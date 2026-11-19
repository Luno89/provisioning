export type GpuVendor = 'nvidia' | 'amd';

export const GPU_VENDORS: readonly GpuVendor[] = ['nvidia', 'amd'];

export const GPU_VENDOR_LABELS: Record<GpuVendor, string> = { nvidia: 'NVIDIA', amd: 'AMD' };

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

export interface GpuWithoutDriver {
  vendor: GpuVendor;
  device: string;
  count: number;
}

export const LSPCI_QUERY = ['-vmmnnk'];

const PCI_VENDORS: Record<string, { vendor: GpuVendor; driver: string }> = {
  '10de': { vendor: 'nvidia', driver: 'nvidia' },
  '1002': { vendor: 'amd', driver: 'amdgpu' },
};

const pciCode = (value: string): string | undefined => /\[([0-9a-f]{4})\]$/i.exec(value.trim())?.[1]?.toLowerCase();

const pciName = (value: string): string => value.trim().replace(/\s*\[[0-9a-f]{4}\]$/i, '').trim();

export function gpusWithoutDriver(lspci: string): GpuWithoutDriver[] {
  const found: GpuWithoutDriver[] = [];
  for (const record of lspci.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of record.split('\n')) {
      const at = line.indexOf(':');
      if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    if (!pciCode(fields.get('Class') ?? '')?.startsWith('03')) continue;
    const vendorId = pciCode(fields.get('Vendor') ?? '');
    const known = vendorId ? PCI_VENDORS[vendorId] : undefined;
    if (!known || fields.get('Driver') === known.driver) continue;
    const named = pciName(fields.get('Device') ?? '');
    const device = named && named !== 'Device' ? named : `device ${vendorId}:${pciCode(fields.get('Device') ?? '') ?? 'unknown'}`;
    const same = found.find((entry) => entry.vendor === known.vendor && entry.device === device);
    if (same) same.count += 1;
    else found.push({ vendor: known.vendor, device, count: 1 });
  }
  return found;
}

export interface GpuReport {
  gpus: MachineGpu[];
  problems: string[];
  withoutDriver: GpuWithoutDriver[];
}

export interface MachineCapacity {
  cpuCores: number;
  memoryMiB: number;
}
