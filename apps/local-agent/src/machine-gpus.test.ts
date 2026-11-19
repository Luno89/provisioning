import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LSPCI_QUERY } from '@koala/engine-core';
import { KFD_NODES, machineGpus, NVIDIA_CDI_HOOK, NVIDIA_RUNTIME, type GpuProbe } from './machine-gpus.js';

const missing = () => Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });

const NO_DRIVER_3090 = 'Slot:\t01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tGA102 [GeForce RTX 3090] [2204]\nModule:\tnouveau\n';

function probe(opts: { smi?: string | Error; kfd?: Record<string, string>; kfdUnreadable?: boolean; cdi?: boolean; runtime?: boolean; lspci?: string | Error; platform?: NodeJS.Platform }) {
  const machine = mock<GpuProbe>({ platform: opts.platform ?? 'linux' });
  machine.run.mockImplementation(async (file, args) => {
    if (file === 'lspci' && args.join(' ') === LSPCI_QUERY.join(' ')) {
      if (opts.lspci instanceof Error) throw opts.lspci;
      return opts.lspci ?? '';
    }
    if (file !== 'nvidia-smi') throw new Error(file);
    if (opts.smi instanceof Error || opts.smi === undefined) throw opts.smi ?? missing();
    return opts.smi;
  });
  machine.exists.mockImplementation(async (path) => (path === KFD_NODES && Boolean(opts.kfd || opts.kfdUnreadable)) || (Boolean(opts.cdi) && path === NVIDIA_CDI_HOOK) || (Boolean(opts.runtime) && path === NVIDIA_RUNTIME));
  machine.list.mockImplementation(async () => {
    if (opts.kfdUnreadable) throw new Error('EACCES: permission denied');
    return Object.keys(opts.kfd ?? {});
  });
  machine.read.mockImplementation(async (path) => {
    const node = Object.entries(opts.kfd ?? {}).find(([name]) => path === `${KFD_NODES}/${name}/properties`);
    if (!node) throw new Error(path);
    return node[1];
  });
  return machine;
}

describe('what a machine says about its GPUs', () => {
  it('has none and no problem when it has no NVIDIA driver and no AMD kernel driver', async () => {
    expect(await machineGpus(probe({}))).toEqual({ gpus: [], problems: [], withoutDriver: [] });
  });

  it('says the NVIDIA driver needs fixing when nvidia-smi is there but does not answer, rather than calling it no GPU', async () => {
    const report = await machineGpus(probe({ smi: new Error('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver\nmore') }));
    expect(report).toEqual({ gpus: [], problems: ['nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver'], withoutDriver: [] });
  });

  it('says the AMD cards cannot be read when the kernel driver is there but its topology is not readable', async () => {
    expect(await machineGpus(probe({ kfdUnreadable: true }))).toEqual({ gpus: [], problems: ['the AMD kernel driver is loaded but its GPU list cannot be read: EACCES: permission denied'], withoutDriver: [] });
  });

  it('leaves the integrated AMD GPU out and keeps the NVIDIA cards, usable once NVIDIA\'s CDI hook and its container runtime are installed', async () => {
    const kfd = { 0: 'cpu_cores_count 8\nsimd_count 0\nvendor_id 0\n', 1: 'cpu_cores_count 0\nsimd_count 4\nlocal_mem_size 0\nvendor_id 4098\n' };
    const report = await machineGpus(probe({ smi: 'NVIDIA GeForce RTX 3090, 24576\nNVIDIA GeForce RTX 3090, 24576\n', kfd, cdi: true, runtime: true }));
    expect(report).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], problems: [], withoutDriver: [] });
  });

  it('takes neither NVIDIA\'s CDI hook nor its container runtime alone as a way to give pods the GPUs: pods get them through CDI, and the device plugin runs under the runtime', async () => {
    const one = [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 1, runtime: false }];
    expect((await machineGpus(probe({ smi: 'NVIDIA GeForce RTX 3090, 24576\n', runtime: true }))).gpus).toEqual(one);
    expect((await machineGpus(probe({ smi: 'NVIDIA GeForce RTX 3090, 24576\n', cdi: true }))).gpus).toEqual(one);
  });

  it('counts a discrete AMD card, which needs no runtime of its own', async () => {
    const kfd = { 1: 'cpu_cores_count 0\nsimd_count 192\nlocal_mem_size 25753026560\ngfx_target_version 110000\nvendor_id 4098\n' };
    expect((await machineGpus(probe({ kfd }))).gpus).toEqual([{ vendor: 'amd', model: 'AMD gfx1100', memoryMiB: 24560, count: 1, runtime: true }]);
  });

  it('says an NVIDIA card is there without its driver when lspci sees it and nvidia-smi is not installed', async () => {
    expect(await machineGpus(probe({ lspci: NO_DRIVER_3090 }))).toEqual({ gpus: [], problems: [], withoutDriver: [{ vendor: 'nvidia', device: 'GA102 [GeForce RTX 3090]', count: 1 }] });
  });

  it('says it cannot tell whether a GPU is missing its driver when lspci is not installed, rather than calling it no GPU', async () => {
    const report = await machineGpus(probe({ lspci: Object.assign(new Error('spawn lspci ENOENT'), { code: 'ENOENT' }) }));
    expect(report).toEqual({ gpus: [], problems: ['lspci is not installed here, so Koala cannot tell whether a GPU here is missing its driver'], withoutDriver: [] });
  });

  it('says lspci failed when it does not answer', async () => {
    const report = await machineGpus(probe({ lspci: new Error('lspci: Cannot open /sys/bus/pci/devices\nmore') }));
    expect(report).toEqual({ gpus: [], problems: ['lspci does not answer, so Koala cannot tell whether a GPU here is missing its driver: lspci: Cannot open /sys/bus/pci/devices'], withoutDriver: [] });
  });

  it('looks for no PCI cards on macOS, whose GPUs come with the system\'s own driver', async () => {
    const machine = probe({ platform: 'darwin', lspci: NO_DRIVER_3090 });
    expect(await machineGpus(machine)).toEqual({ gpus: [], problems: [], withoutDriver: [] });
    expect(machine.run.mock.calls.map(([file]) => file)).not.toContain('lspci');
  });
});
