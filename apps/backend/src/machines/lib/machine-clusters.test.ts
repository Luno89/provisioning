import { describe, expect, it } from 'vitest';
import { MOST_GPUS_OF_A_KIND, reportedCluster, reportedGpus } from './machine-clusters.js';

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

  it('keeps a few problems, each a line of words, and nothing else', () => {
    expect(reportedCluster({ state: 'running', gpus: [], problems: ['a', 7, '', 'b'.repeat(600), ...Array.from({ length: 10 }, () => 'c')] })?.gpus?.problems).toEqual(['a', 'b'.repeat(500), 'c', 'c', 'c', 'c', 'c', 'c']);
  });
});
