import { describe, expect, it } from 'vitest';
import type { MachineGpu } from '@koala/engine-core';
import { advertisedGpus, gpuAskOf, gpuChangeRefusal, gpuDeployRefusal, gpuPluginState, runtimeRefused } from './cluster-gpus.js';

const RTX: MachineGpu = { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true };
const desk = (extra: Partial<{ gpus: MachineGpu[]; gpuProblems: string[]; provider: 'machine' | 'pool' | 'root' }> = {}) => ({ name: 'desk', provider: 'machine' as const, gpus: [RTX], gpuProblems: [], ...extra });

describe('the GPUs an app asks for', () => {
  it('is the count the request names, 1 or more, and is refused when a GPU app names none or 0', () => {
    expect(gpuAskOf('vllm', { vllmGpuCount: 2, vllmGpuVendor: 'nvidia' })).toEqual({ count: 2, vendor: 'nvidia' });
    expect(gpuAskOf('vllm', { vllmGpuCount: '1' })).toEqual({ count: 1 });
    expect(gpuAskOf('tabbyapi', { tabbyGpuCount: 2 })).toEqual({ count: 2, vendor: 'nvidia' });
    expect(gpuAskOf('vllm', { vllmGpuCount: 0 })).toEqual({ problem: 'Say how many GPUs vLLM uses: 1 or more. Koala runs no model on CPU.' });
    expect(gpuAskOf('tabbyapi', { tabbyGpuCount: 0 })).toEqual({ problem: 'Say how many GPUs TabbyAPI uses: 1 or more. Koala runs no model on CPU.' });
    expect(gpuAskOf('odoo', {})).toBeUndefined();
    expect(gpuAskOf('vllm', {})).toEqual({ problem: 'Say how many GPUs vLLM uses: 1 or more. Koala runs no model on CPU.' });
    expect(gpuAskOf('tabbyapi', { tabbyGpuCount: 'many' })).toEqual({ problem: 'Say how many GPUs TabbyAPI uses: 1 or more. Koala runs no model on CPU.' });
  });
});

describe('a deploy that asks for GPUs, against what the machine says it has', () => {
  it('goes ahead on the vendor the machine has when the request names none, or the one it names', () => {
    expect(gpuDeployRefusal(desk(), { count: 2 })).toEqual({ vendor: 'nvidia' });
    expect(gpuDeployRefusal(desk(), { count: 1, vendor: 'nvidia' })).toEqual({ vendor: 'nvidia' });
  });

  it('is refused with what to do: a machine that sees no GPU, its driver broken, no toolkit, too few, the wrong vendor, two vendors and none named', () => {
    expect(gpuDeployRefusal(desk({ gpus: [] }), { count: 1 })).toEqual({ refused: 'This app asks for 1 GPU, and desk shows none: if it has one, install its driver so nvidia-smi or the AMD kernel driver answers, then reconnect its agent.' });
    expect(gpuDeployRefusal(desk({ gpus: [], gpuProblems: ['nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: no devices'] }), { count: 1 }))
      .toEqual({ refused: 'This app asks for 1 GPU, and desk shows none: nvidia-smi is installed but does not answer, so the NVIDIA driver needs fixing: no devices.' });
    expect(gpuDeployRefusal(desk({ gpus: [{ ...RTX, runtime: false }] }), { count: 1 }))
      .toEqual({ refused: 'This app asks for 1 NVIDIA GPU. desk has 2 NVIDIA GPUs, and pods there cannot be given them yet: NVIDIA\'s CDI support is not installed. Run the command from My Machines again on it, which offers to install it (the NVIDIA Container Toolkit).' });
    expect(gpuDeployRefusal(desk(), { count: 3 })).toEqual({ refused: 'This app asks for 3 NVIDIA GPUs, and desk has 2 NVIDIA GPUs. Ask for 2 or fewer.' });
    expect(gpuDeployRefusal(desk(), { count: 1, vendor: 'amd' })).toEqual({ refused: 'This app asks for 1 AMD GPU, and desk has no AMD GPU (it has 2 × NVIDIA GeForce RTX 3090). Pick another machine, or CPU only.' });
    const both = desk({ gpus: [RTX, { vendor: 'amd', model: 'AMD gfx1100', memoryMiB: 24560, count: 1, runtime: true }] });
    expect(gpuDeployRefusal(both, { count: 1 })).toEqual({ refused: 'This app asks for 1 GPU, and desk has NVIDIA and AMD GPUs: say which to use.' });
  });

  it('is refused on a cluster that is not a machine\'s, and on a machine whose agent has not said which GPUs it has', () => {
    expect(gpuDeployRefusal(desk({ provider: 'pool' }), { count: 1 })).toEqual({ refused: 'This app asks for 1 GPU, and only a machine\'s own cluster runs apps on GPUs; desk is not one. Pick one of your machines that has them, or CPU only.' });
    expect(gpuDeployRefusal({ name: 'desk', provider: 'machine' }, { count: 1 })).toEqual({ refused: 'This app asks for 1 GPU, and desk has not said which GPUs it has: its agent is from before GPUs were reported, or it has not connected since. Once it connects with a current agent, it says.' });
  });
});

describe('an app\'s settings that change the GPUs it runs on', () => {
  const desk = { name: 'desk', provider: 'machine' as const, gpus: [{ vendor: 'nvidia' as const, model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }] };

  it('are decided as a deploy is, against what the machine reports, and leave other settings alone', () => {
    expect(gpuChangeRefusal({ appType: 'vllm', vllmGpuCount: 1 }, { vllmGpuCount: 2 }, desk)).toEqual({ vendor: 'nvidia' });
    expect(gpuChangeRefusal({ appType: 'vllm', vllmGpuCount: 1 }, { vllmGpuCount: 4 }, desk)).toEqual({ refused: 'This app asks for 4 NVIDIA GPUs, and desk has 2 NVIDIA GPUs. Ask for 2 or fewer.' });
    expect(gpuChangeRefusal({ appType: 'tabbyapi', tabbyGpuCount: 1 }, { tabbyGpuCount: 0 }, desk)).toEqual({ refused: 'Say how many GPUs TabbyAPI uses: 1 or more. Koala runs no model on CPU.' });
    expect(gpuChangeRefusal({ appType: 'vllm', vllmGpuCount: 1 }, { vllmModel: 'Qwen/Qwen3-8B' }, desk)).toBeUndefined();
    expect(gpuChangeRefusal({ appType: 'vllm', vllmGpuCount: 1 }, { vllmGpuCount: 2 }, undefined)).toEqual({ refused: 'This app asks for GPUs, and its cluster is not known here.' });
  });
});

describe('a machine\'s GPUs, readied', () => {
  const nodes = (allocatable: Record<string, string>) => ({ items: [{ status: { allocatable } }] });

  it('counts what the node advertises', () => {
    expect(advertisedGpus(nodes({ 'nvidia.com/gpu': '2', cpu: '16' }), 'nvidia.com/gpu')).toBe(2);
    expect(advertisedGpus(nodes({ cpu: '16' }), 'nvidia.com/gpu')).toBe(0);
    expect(advertisedGpus('nonsense', 'nvidia.com/gpu')).toBe(0);
  });

  it('is ready only once the plugin runs its new spec and the node advertises what the app asks, and fails with what to do when it cannot run', () => {
    expect(gpuPluginState({ vendor: 'nvidia', count: 2 }, 2, { state: 'done' }, 'desk')).toEqual({ state: 'ready' });
    expect(gpuPluginState({ vendor: 'nvidia', count: 2 }, 2, { state: 'rolling', waiting: 'daemonset/nvidia-device-plugin-daemonset has 0 of 1 updated' }, 'desk'))
      .toEqual({ state: 'waiting', reason: 'the NVIDIA device plugin is not running its new spec yet: daemonset/nvidia-device-plugin-daemonset has 0 of 1 updated' });
    expect(gpuPluginState({ vendor: 'nvidia', count: 2 }, 0, { state: 'done' }, 'desk')).toEqual({ state: 'waiting', reason: 'the node advertises 0 of the 2 NVIDIA GPUs asked for so far' });
    expect(gpuPluginState({ vendor: 'nvidia', count: 2 }, 2, { state: 'hopeless', reason: 'its container keeps crashing' }, 'desk'))
      .toEqual({ state: 'failed', reason: 'the NVIDIA device plugin cannot run on desk: its container keeps crashing. Run the command from My Machines again on it, which offers to install NVIDIA\'s CDI support (the NVIDIA Container Toolkit), restart k3s there once it is installed, then deploy again.' });
  });

  it('reads a pod sandbox the runtime refused for want of the NVIDIA runtime, and nothing else', () => {
    const event = (reason: string, message: string) => ({ items: [{ reason, message }] });
    expect(runtimeRefused(event('FailedCreatePodSandBox', 'failed to get sandbox runtime: no runtime for "nvidia" is configured'))).toBe('failed to get sandbox runtime: no runtime for "nvidia" is configured');
    expect(runtimeRefused(event('BackOff', 'Back-off restarting failed container'))).toBeUndefined();
    expect(runtimeRefused('nonsense')).toBeUndefined();
  });
});
