import path from 'node:path';
import { amdDiscreteCards, groupedGpus, NVIDIA_SMI_QUERY, nvidiaCards, type GpuCard, type GpuReport, type GpuVendor } from '@koala/engine-core';

export interface GpuProbe {
  run(file: string, args: string[]): Promise<string>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
}

export const KFD_NODES = '/sys/class/kfd/kfd/topology/nodes';

export const NVIDIA_CDI_HOOK = '/usr/bin/nvidia-cdi-hook';

type Read = { cards: GpuCard[] } | { problem: string };

async function nvidiaOf(probe: GpuProbe): Promise<Read> {
  try {
    return { cards: nvidiaCards(await probe.run('nvidia-smi', NVIDIA_SMI_QUERY)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { cards: [] };
    return { problem: `nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: ${(err as Error).message.split('\n')[0]}` };
  }
}

async function amdOf(probe: GpuProbe): Promise<Read> {
  if (!await probe.exists(KFD_NODES)) return { cards: [] };
  let nodes: string[];
  try {
    nodes = await probe.list(KFD_NODES);
  } catch (err) {
    return { problem: `the AMD kernel driver is loaded but its GPU list cannot be read: ${(err as Error).message}` };
  }
  const read = await Promise.all(nodes.map((node) => probe.read(path.join(KFD_NODES, node, 'properties')).then((properties) => ({ properties }), () => ({ properties: '' }))));
  return { cards: amdDiscreteCards(read) };
}

export async function machineGpus(probe: GpuProbe): Promise<GpuReport> {
  const reads = [await nvidiaOf(probe), await amdOf(probe)];
  const problems = reads.flatMap((read) => ('problem' in read ? [read.problem] : []));
  const cards = reads.flatMap((read) => ('cards' in read ? read.cards : []));
  if (!cards.length) return { gpus: [], problems };
  const cdi = cards.some((card) => card.vendor === 'nvidia') && await probe.exists(NVIDIA_CDI_HOOK);
  const usable = (vendor: GpuVendor): boolean => vendor === 'amd' || cdi;
  return { gpus: groupedGpus(cards, usable), problems };
}
