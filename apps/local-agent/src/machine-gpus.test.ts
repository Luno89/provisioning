import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { KFD_NODES, machineGpus, NVIDIA_CDI_HOOK, type GpuProbe } from './machine-gpus.js';

const missing = () => Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });

function probe(opts: { smi?: string | Error; kfd?: Record<string, string>; kfdUnreadable?: boolean; cdi?: boolean; runtimeOnly?: boolean }) {
  const machine = mock<GpuProbe>();
  machine.run.mockImplementation(async (file) => {
    if (file !== 'nvidia-smi') throw new Error(file);
    if (opts.smi instanceof Error || opts.smi === undefined) throw opts.smi ?? missing();
    return opts.smi;
  });
  machine.exists.mockImplementation(async (path) => (path === KFD_NODES && Boolean(opts.kfd || opts.kfdUnreadable)) || (Boolean(opts.cdi) && path === NVIDIA_CDI_HOOK) || (Boolean(opts.runtimeOnly) && path === '/usr/bin/nvidia-container-runtime'));
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
    expect(await machineGpus(probe({}))).toEqual({ gpus: [], problems: [] });
  });

  it('says the NVIDIA driver needs fixing when nvidia-smi is there but does not answer, rather than calling it no GPU', async () => {
    const report = await machineGpus(probe({ smi: new Error('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver\nmore') }));
    expect(report).toEqual({ gpus: [], problems: ['nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver'] });
  });

  it('says the AMD cards cannot be read when the kernel driver is there but its topology is not readable', async () => {
    expect(await machineGpus(probe({ kfdUnreadable: true }))).toEqual({ gpus: [], problems: ['the AMD kernel driver is loaded but its GPU list cannot be read: EACCES: permission denied'] });
  });

  it('leaves the integrated AMD GPU out and keeps the NVIDIA cards, usable once NVIDIA\'s CDI hook is installed', async () => {
    const kfd = { 0: 'cpu_cores_count 8\nsimd_count 0\nvendor_id 0\n', 1: 'cpu_cores_count 0\nsimd_count 4\nlocal_mem_size 0\nvendor_id 4098\n' };
    const report = await machineGpus(probe({ smi: 'NVIDIA GeForce RTX 3090, 24576\nNVIDIA GeForce RTX 3090, 24576\n', kfd, cdi: true }));
    expect(report).toEqual({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], problems: [] });
  });

  it('does not take NVIDIA\'s container runtime alone as a way to give pods the GPUs, since pods get them through CDI', async () => {
    const report = await machineGpus(probe({ smi: 'NVIDIA GeForce RTX 3090, 24576\n', runtimeOnly: true }));
    expect(report.gpus).toEqual([{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 1, runtime: false }]);
  });

  it('counts a discrete AMD card, which needs no runtime of its own', async () => {
    const kfd = { 1: 'cpu_cores_count 0\nsimd_count 192\nlocal_mem_size 25753026560\ngfx_target_version 110000\nvendor_id 4098\n' };
    expect((await machineGpus(probe({ kfd }))).gpus).toEqual([{ vendor: 'amd', model: 'AMD gfx1100', memoryMiB: 24560, count: 1, runtime: true }]);
  });
});
