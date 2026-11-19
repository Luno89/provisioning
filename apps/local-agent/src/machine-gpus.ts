import path from 'node:path';
import { amdDiscreteCards, groupedGpus, gpusWithoutDriver, LSPCI_QUERY, NVIDIA_SMI_QUERY, nvidiaCards, type GpuCard, type GpuReport, type GpuVendor, type GpuWithoutDriver } from '@koala/engine-core';

export interface GpuProbe {
  platform: NodeJS.Platform;
  run(file: string, args: string[]): Promise<string>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
}

export const KFD_NODES = '/sys/class/kfd/kfd/topology/nodes';

export const NVIDIA_CDI_HOOK = '/usr/bin/nvidia-cdi-hook';
export const NVIDIA_RUNTIME = '/usr/bin/nvidia-container-runtime';

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

const CANNOT_TELL = 'so Koala cannot tell whether a GPU here is missing its driver';

export async function driverlessOf(probe: Pick<GpuProbe, 'platform' | 'run'>): Promise<{ withoutDriver: GpuWithoutDriver[] } | { problem: string }> {
  if (probe.platform !== 'linux') return { withoutDriver: [] };
  try {
    return { withoutDriver: gpusWithoutDriver(await probe.run('lspci', LSPCI_QUERY)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { problem: `lspci is not installed here, ${CANNOT_TELL}` };
    return { problem: `lspci does not answer, ${CANNOT_TELL}: ${(err as Error).message.split('\n')[0]}` };
  }
}

export async function machineGpus(probe: GpuProbe): Promise<GpuReport> {
  const reads = [await nvidiaOf(probe), await amdOf(probe)];
  const driverless = await driverlessOf(probe);
  const problems = [...reads, driverless].flatMap((read) => ('problem' in read ? [read.problem] : []));
  const withoutDriver = 'withoutDriver' in driverless ? driverless.withoutDriver : [];
  const cards = reads.flatMap((read) => ('cards' in read ? read.cards : []));
  if (!cards.length) return { gpus: [], problems, withoutDriver };
  const [hook, runtime] = await Promise.all([probe.exists(NVIDIA_CDI_HOOK), probe.exists(NVIDIA_RUNTIME)]);
  const cdi = cards.some((card) => card.vendor === 'nvidia') && hook && runtime;
  const usable = (vendor: GpuVendor): boolean => vendor === 'amd' || cdi;
  return { gpus: groupedGpus(cards, usable), problems, withoutDriver };
}
