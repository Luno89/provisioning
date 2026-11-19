import { describe, expect, it } from 'vitest';
import { amdDiscreteCards, gfxName, gpuCountOf, gpusWithoutDriver, groupedGpus, nvidiaCards, usableVendors } from './machine-gpus.js';

const pci = (slot: string, klass: string, vendor: string, device: string, driver?: string): string =>
  [`Slot:\t${slot}`, `Class:\t${klass}`, `Vendor:\t${vendor}`, `Device:\t${device}`, 'Rev:\ta1', ...(driver ? [`Driver:\t${driver}`] : []), 'Module:\tnouveau', 'IOMMUGroup:\t13'].join('\n');

describe('the GPUs a machine has whose driver is not installed, from lspci', () => {
  it('names each NVIDIA or AMD card with no driver of its vendor\'s, counted by device, and leaves the ones whose driver is there', () => {
    const lspci = [
      pci('01:00.0', 'VGA compatible controller [0300]', 'NVIDIA Corporation [10de]', 'GA102 [GeForce RTX 3090] [2204]'),
      pci('06:00.0', 'VGA compatible controller [0300]', 'NVIDIA Corporation [10de]', 'GA102 [GeForce RTX 3090] [2204]', 'nouveau'),
      pci('07:00.0', '3D controller [0302]', 'NVIDIA Corporation [10de]', 'AD102 [GeForce RTX 4090] [2684]', 'nvidia'),
      pci('0c:00.0', 'VGA compatible controller [0300]', 'Advanced Micro Devices, Inc. [AMD/ATI] [1002]', 'Navi 31 [Radeon RX 7900 XT/7900 XTX] [744c]'),
      pci('79:00.0', 'VGA compatible controller [0300]', 'Advanced Micro Devices, Inc. [AMD/ATI] [1002]', 'Raphael [164e]', 'amdgpu'),
      pci('00:02.0', 'VGA compatible controller [0300]', 'Intel Corporation [8086]', 'Alder Lake-S GT1 [UHD Graphics 730] [4692]'),
      pci('02:00.0', 'Audio device [0403]', 'NVIDIA Corporation [10de]', 'GA102 High Definition Audio Controller [1aef]'),
    ].join('\n\n');
    expect(gpusWithoutDriver(`${lspci}\n`)).toEqual([
      { vendor: 'nvidia', device: 'GA102 [GeForce RTX 3090]', count: 2 },
      { vendor: 'amd', device: 'Navi 31 [Radeon RX 7900 XT/7900 XTX]', count: 1 },
    ]);
  });

  it('names a card lspci has no name for by its PCI ids', () => {
    expect(gpusWithoutDriver(pci('01:00.0', 'VGA compatible controller [0300]', 'NVIDIA Corporation [10de]', 'Device [2b85]'))).toEqual([{ vendor: 'nvidia', device: 'device 10de:2b85', count: 1 }]);
  });

  it('has none on a machine with no display controller', () => {
    expect(gpusWithoutDriver('')).toEqual([]);
  });
});

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
