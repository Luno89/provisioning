import { describe, expect, it } from 'vitest';
import { amdDiscreteCards, gfxName, gpuCountOf, groupedGpus, nvidiaCards, usableVendors } from './machine-gpus.js';

const RAPHAEL = 'cpu_cores_count 0\nsimd_count 4\nlocal_mem_size 0\ngfx_target_version 100306\nvendor_id 4098\ndevice_id 5710\n';
const NAVI31 = 'cpu_cores_count 0\nsimd_count 192\nlocal_mem_size 25753026560\ngfx_target_version 110000\nvendor_id 4098\n';
const CPU = 'cpu_cores_count 8\nsimd_count 0\nvendor_id 0\n';

describe('the GPUs a machine reads for itself', () => {
  it('takes each NVIDIA card nvidia-smi names, with its memory, and nothing it cannot read', () => {
    expect(nvidiaCards('NVIDIA GeForce RTX 3090, 24576\nNVIDIA GeForce RTX 3090, 24576\n\nbroken line\nNVIDIA A, not a number\n')).toEqual([
      { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576 },
      { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576 },
    ]);
  });

  it('takes an AMD card only when it is discrete: an integrated one has no memory of its own', () => {
    expect(amdDiscreteCards([{ properties: CPU }, { properties: RAPHAEL }])).toEqual([]);
    expect(amdDiscreteCards([{ properties: CPU }, { properties: NAVI31 }])).toEqual([{ vendor: 'amd', model: 'AMD gfx1100', memoryMiB: 24560 }]);
    expect(amdDiscreteCards([{ properties: 'cpu_cores_count 4\nsimd_count 8\nlocal_mem_size 1073741824\nvendor_id 4098\n' }])).toEqual([]);
  });

  it('names an AMD target as ROCm does', () => {
    expect(gfxName(100306)).toBe('gfx1036');
    expect(gfxName(90010)).toBe('gfx90a');
  });

  it('groups like cards and counts only those whose runtime is there', () => {
    const cards = [...nvidiaCards('RTX 3090, 24576\nRTX 3090, 24576\nRTX 4090, 24564'), ...amdDiscreteCards([{ properties: NAVI31 }])];
    const gpus = groupedGpus(cards, (vendor) => vendor === 'amd');
    expect(gpus).toEqual([
      { vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: false },
      { vendor: 'nvidia', model: 'RTX 4090', memoryMiB: 24564, count: 1, runtime: false },
      { vendor: 'amd', model: 'AMD gfx1100', memoryMiB: 24560, count: 1, runtime: true },
    ]);
    expect(gpuCountOf(gpus, 'nvidia')).toBe(0);
    expect(gpuCountOf(gpus, 'nvidia', false)).toBe(3);
    expect(usableVendors(gpus)).toEqual(['amd']);
    expect(usableVendors(undefined)).toEqual([]);
  });
});
