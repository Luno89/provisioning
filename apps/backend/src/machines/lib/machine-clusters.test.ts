import { describe, expect, it } from 'vitest';
import type { MachineGpu } from '@koala/engine-core';
import { clusterCapacityOf, MOST_GPUS_OF_A_KIND, reportedCluster, reportedGpus } from './machine-clusters.js';

const RTX = { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true };

describe('what a machine reports about its cluster', () => {
  it('is its state, its GPUs and the problems it had reading them, and an agent from before GPUs reports none to keep or replace', () => {
    expect(reportedCluster({ state: 'running', gpus: [RTX], problems: [] })).toEqual({ state: 'running', gpus: { gpus: [RTX], problems: [] } });
    expect(reportedCluster({ state: 'stopped', gpus: [], problems: ['nvidia-smi is installed but does not answer'] })).toEqual({ state: 'stopped', gpus: { gpus: [], problems: ['nvidia-smi is installed but does not answer'] } });
    expect(reportedCluster({ state: 'stopped' })).toEqual({ state: 'stopped' });
    expect(reportedCluster({ state: 'exploded', gpus: [RTX] })).toBeUndefined();
    expect(reportedCluster(undefined)).toBeUndefined();
  });

  it('keeps only GPUs it can read whole: a vendor Koala knows, a name, memory, a count and whether the runtime is there', () => {
    expect(reportedGpus('nonsense')).toBeUndefined();
    expect(reportedGpus([
      RTX,
      { ...RTX, vendor: 'intel' },
      { ...RTX, model: '  ' },
      { ...RTX, memoryMiB: -1 },
      { ...RTX, memoryMiB: 1.5 },
      { ...RTX, count: 0 },
      { ...RTX, count: MOST_GPUS_OF_A_KIND + 1 },
      { ...RTX, runtime: 'yes' },
      null,
      { ...RTX, vendor: 'amd', model: `  ${'x'.repeat(200)}`, extra: 'dropped' },
    ])).toEqual([RTX, { ...RTX, vendor: 'amd', model: 'x'.repeat(120) }]);
  });

  it('carries how many cores and how much memory the machine has, kept only when both are whole numbers above nothing', () => {
    expect(reportedCluster({ state: 'running', gpus: [RTX], problems: [], capacity: { cpuCores: 16, memoryMiB: 64215 } })).toEqual({ state: 'running', gpus: { gpus: [RTX], problems: [] }, capacity: { cpuCores: 16, memoryMiB: 64215 } });
    expect(reportedCluster({ state: 'stopped', capacity: { cpuCores: 8, memoryMiB: 32000 } })).toEqual({ state: 'stopped', capacity: { cpuCores: 8, memoryMiB: 32000 } });
    for (const capacity of [{ cpuCores: 0, memoryMiB: 1 }, { cpuCores: 2.5, memoryMiB: 1 }, { cpuCores: 2, memoryMiB: -1 }, { cpuCores: 2 }, 'lots'] as unknown[]) {
      expect(reportedCluster({ state: 'stopped', capacity })).toEqual({ state: 'stopped' });
    }
  });

  it('is kept on the cluster as its cores, its memory in GiB and the GPUs pods can be given there, of the vendor it has most of', () => {
    expect(clusterCapacityOf({ cpuCores: 16, memoryMiB: 65536 }, [RTX as MachineGpu])).toEqual({ cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' });
    expect(clusterCapacityOf({ cpuCores: 8, memoryMiB: 31744 }, [{ ...RTX, runtime: false } as MachineGpu])).toEqual({ cpuCores: 8, ramGb: 31 });
    expect(clusterCapacityOf({ cpuCores: 8, memoryMiB: 31744 }, [{ ...RTX, count: 1 } as MachineGpu, { ...RTX, vendor: 'amd', model: 'AMD gfx1100' } as MachineGpu])).toEqual({ cpuCores: 8, ramGb: 31, gpuCount: 2, gpuVendor: 'amd' });
    expect(clusterCapacityOf({ cpuCores: 4, memoryMiB: 8192 }, undefined)).toEqual({ cpuCores: 4, ramGb: 8 });
  });

  it('keeps a few problems, each a line of words, and nothing else', () => {
    expect(reportedCluster({ state: 'running', gpus: [], problems: ['a', 7, '', 'b'.repeat(600), ...Array.from({ length: 10 }, () => 'c')] })?.gpus?.problems).toEqual(['a', 'b'.repeat(500), 'c', 'c', 'c', 'c', 'c', 'c']);
  });
});
