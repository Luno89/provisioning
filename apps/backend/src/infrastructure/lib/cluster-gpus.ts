import { GPU_VENDORS, gpuCountOf, type GpuVendor } from '@koala/engine-core';
import type { ClusterMetadata } from '../../platform/index.js';
import type { Rollout } from './rollout.js';

export interface GpuPlugin {
  manifest: string;
  daemonSet: string;
  namespace: string;
  selector: string;
  resource: string;
  label: string;
}

export const GPU_PLUGINS: Record<GpuVendor, GpuPlugin> = {
  nvidia: { manifest: 'k8s/gpu-device-plugin/nvidia.yaml', daemonSet: 'nvidia-device-plugin-daemonset', namespace: 'kube-system', selector: 'name=nvidia-device-plugin-ds', resource: 'nvidia.com/gpu', label: 'NVIDIA' },
  amd: { manifest: 'k8s/gpu-device-plugin/amd.yaml', daemonSet: 'amdgpu-device-plugin-daemonset', namespace: 'kube-system', selector: 'name=amdgpu-dp-ds', resource: 'amd.com/gpu', label: 'AMD' },
};

const GPU_APPS: Record<string, { countField: string; vendorField?: string; vendor?: GpuVendor; label: string }> = {
  vllm: { countField: 'vllmGpuCount', vendorField: 'vllmGpuVendor', label: 'vLLM' },
  tabbyapi: { countField: 'tabbyGpuCount', vendor: 'nvidia', label: 'TabbyAPI' },
};

export interface GpuAsk {
  count: number;
  vendor?: GpuVendor | undefined;
}

export function gpuAskOf(appType: string, config: Record<string, unknown>): GpuAsk | { problem: string } | undefined {
  const app = GPU_APPS[appType];
  if (!app) return undefined;
  const raw = config[app.countField];
  const count = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(count) || count < 0) return { problem: `Say how many GPUs ${app.label} uses: 1 or more, or 0 for CPU only.` };
  if (count === 0) return undefined;
  const named = app.vendorField ? config[app.vendorField] : undefined;
  const vendor = app.vendor ?? (GPU_VENDORS.includes(named as GpuVendor) ? named as GpuVendor : undefined);
  return vendor ? { count, vendor } : { count };
}

export const GPU_CDI_HINT = 'Run the command from My Machines again on it, which offers to install it (the NVIDIA Container Toolkit).';

const plural = (count: number, label?: string) => `${count} ${label ? `${label} ` : ''}GPU${count === 1 ? '' : 's'}`;

export type GpuDecision = { vendor: GpuVendor } | { refused: string };

export function gpuDeployRefusal(cluster: Pick<ClusterMetadata, 'name' | 'provider' | 'gpus' | 'gpuProblems'>, ask: GpuAsk): GpuDecision {
  const asked = plural(ask.count, ask.vendor ? GPU_PLUGINS[ask.vendor].label : undefined);
  if (cluster.provider !== 'machine') return { refused: `This app asks for ${asked}, and only a machine's own cluster runs apps on GPUs; ${cluster.name} is not one. Pick one of your machines that has them, or CPU only.` };
  if (!cluster.gpus) return { refused: `This app asks for ${asked}, and ${cluster.name} has not said which GPUs it has: its agent is from before GPUs were reported, or it has not connected since. Once it connects with a current agent, it says.` };
  if (cluster.gpus.length === 0) {
    const why = cluster.gpuProblems?.length ? cluster.gpuProblems.join('; ') : 'if it has one, install its driver so nvidia-smi or the AMD kernel driver answers, then reconnect its agent';
    return { refused: `This app asks for ${asked}, and ${cluster.name} shows none: ${why}.` };
  }
  const present = GPU_VENDORS.filter((vendor) => gpuCountOf(cluster.gpus, vendor, false) > 0);
  if (!ask.vendor && present.length > 1) return { refused: `This app asks for ${asked}, and ${cluster.name} has ${present.map((vendor) => GPU_PLUGINS[vendor].label).join(' and ')} GPUs: say which to use.` };
  const vendor = ask.vendor ?? present[0]!;
  const label = GPU_PLUGINS[vendor].label;
  const there = gpuCountOf(cluster.gpus, vendor, false);
  if (there === 0) {
    const others = cluster.gpus.map((gpu) => `${gpu.count} × ${gpu.model}`).join(', ');
    return { refused: `This app asks for ${asked}, and ${cluster.name} has no ${label} GPU (it has ${others}). Pick another machine, or CPU only.` };
  }
  const usable = gpuCountOf(cluster.gpus, vendor);
  const askedOf = plural(ask.count, label);
  if (usable === 0) return { refused: `This app asks for ${askedOf}. ${cluster.name} has ${plural(there, label)}, and pods there cannot be given them yet: NVIDIA's CDI support is not installed. ${GPU_CDI_HINT}` };
  if (ask.count > usable) return { refused: `This app asks for ${askedOf}, and ${cluster.name} has ${plural(usable, label)}. Ask for ${usable} or fewer.` };
  return { vendor };
}

export function advertisedGpus(nodes: unknown, resource: string): number {
  const items = (nodes as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const node of items) {
    const value = Number((node as { status?: { allocatable?: Record<string, unknown> } } | undefined)?.status?.allocatable?.[resource] ?? 0);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

export type GpuPluginState = { state: 'ready' } | { state: 'waiting'; reason: string } | { state: 'failed'; reason: string };

export function gpuPluginState(want: { vendor: GpuVendor; count: number }, advertised: number, plugin: Rollout, machine: string): GpuPluginState {
  const label = GPU_PLUGINS[want.vendor].label;
  if (plugin.state === 'hopeless') {
    const fix = want.vendor === 'nvidia' ? ` Run the command from My Machines again on it, which offers to install NVIDIA's CDI support (the NVIDIA Container Toolkit), restart k3s there once it is installed, then deploy again.` : ` Restart k3s on it once the AMD kernel driver is loaded.`;
    return { state: 'failed', reason: `the ${label} device plugin cannot run on ${machine}: ${plugin.reason}.${fix}` };
  }
  if (plugin.state === 'rolling') return { state: 'waiting', reason: `the ${label} device plugin is not running its new spec yet: ${plugin.waiting}` };
  if (advertised >= want.count) return { state: 'ready' };
  return { state: 'waiting', reason: `the node advertises ${advertised} of the ${plural(want.count, label)} asked for so far` };
}

export function runtimeRefused(events: unknown): string | undefined {
  const items = (events as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return undefined;
  for (const event of items) {
    const { reason, message } = (event ?? {}) as { reason?: unknown; message?: unknown };
    if (reason === 'FailedCreatePodSandBox' && typeof message === 'string' && /no runtime for/i.test(message)) return message;
  }
  return undefined;
}
