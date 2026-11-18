import type { Step } from '@koala/provision';
import { K3S_BINARY, K3S_MARKER } from '../machine-cluster.js';
import { SILENT, type JoinContext } from './context.js';
import { helmStep } from './steps/helm.js';
import { joinRootStep } from './steps/join-root.js';
import { k3sConfigStep, k3sFirewallStep, k3sStep, k3sSudoStep, k3sUninstallStep } from './steps/k3s.js';
import { meshStep, tailscaleStep } from './steps/mesh.js';
import { cdiState, manualCdi, nvidiaCdiStep, packageFamily } from './steps/nvidia.js';
import { launchdServiceStep, systemdServiceStep } from './steps/service.js';

export interface Asking {
  yesNo(question: string): Promise<boolean>;
}

export class JoinStopped extends Error {}

export interface JoinPlan {
  steps: Step<JoinContext>[];
  service: Step<JoinContext> | undefined;
}

async function k3sChosen(ctx: JoinContext, ask: Asking, say: (line: string) => void): Promise<boolean> {
  const marker = await ctx.host.read(K3S_MARKER);
  if (await ctx.host.executable(K3S_BINARY) && marker === undefined) {
    say('this machine already runs k3s of its own; Koala leaves it alone and runs no apps here');
    return false;
  }
  if (marker?.trim() === ctx.pins.k3s.version) return true;
  if (await ask.yesNo(`Koala runs apps and workspaces here in k3s, started only while there is work and stopped after. Install k3s ${ctx.pins.k3s.version} (asks for sudo once)?`)) return true;
  say('without it Koala runs only your coding agents here; run this command again to add it');
  return false;
}

async function cdiChosen(ctx: JoinContext, ask: Asking, say: (line: string) => void): Promise<boolean> {
  if (!await ctx.host.which('nvidia-smi')) return false;
  if ((await cdiState(ctx)).done) return true;
  if (await packageFamily(ctx) === 'none') {
    say(manualCdi(ctx.pins.nvidia.version));
    return false;
  }
  if (await ask.yesNo(`This machine has an NVIDIA GPU. Install NVIDIA's CDI support (nvidia-container-toolkit ${ctx.pins.nvidia.version}, from NVIDIA's own repository) so apps here can use it?`)) return true;
  say('without it Koala runs apps here on CPU only; run this command again to add it');
  return false;
}

async function serviceOf(ctx: JoinContext): Promise<Step<JoinContext> | undefined> {
  if (!ctx.args.service) return undefined;
  if (ctx.host.platform === 'darwin') return launchdServiceStep;
  if (ctx.host.platform !== 'linux' || !await ctx.host.which('systemctl')) return undefined;
  const userSystemd = await ctx.commands.run({ command: 'systemctl', args: ['--user', 'show-environment'], accept: [0, 1] }, SILENT);
  return userSystemd.code === 0 ? systemdServiceStep : undefined;
}

export async function planJoin(ctx: JoinContext, ask: Asking, say: (line: string) => void): Promise<JoinPlan> {
  const linux = ctx.host.platform === 'linux';
  const steps: Step<JoinContext>[] = [joinRootStep(ctx.args.url)];
  if (!await ctx.host.which('tailscale')) {
    if (!linux) throw new JoinStopped('install Tailscale from https://tailscale.com/download, then run this again: Koala reaches this machine through it, privately');
    if (!await ask.yesNo('Tailscale isn\'t installed. Koala reaches this machine through it, privately. Install it?')) throw new JoinStopped('stopped: this machine needs the private network to take work');
    steps.push(tailscaleStep(ctx.pins.tailscale.version));
  }
  steps.push(meshStep);
  const k3s = linux && ctx.args.cluster && await k3sChosen(ctx, ask, say);
  if (k3s) {
    steps.push(k3sConfigStep, k3sFirewallStep, k3sUninstallStep, k3sStep(ctx.pins.k3s.version), k3sSudoStep);
    if (await cdiChosen(ctx, ask, say)) steps.push(nvidiaCdiStep(ctx.pins.nvidia.version));
  }
  if (linux && (k3s || await ctx.host.read(K3S_MARKER) !== undefined)) steps.push(helmStep(ctx.pins.helm.version));
  return { steps, service: await serviceOf(ctx) };
}
