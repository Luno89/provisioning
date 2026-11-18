import path from 'node:path';
import { waitUntil, type Progress, type Step } from '@koala/provision';
import { archOf, daemonReload, joinedOf, SILENT, type JoinContext } from '../context.js';

const TAILSCALE_DEFAULTS = '/etc/default/tailscaled';

const tailscaleAnswers = async (ctx: JoinContext): Promise<boolean> =>
  (await ctx.commands.run({ command: 'tailscale', args: ['debug', 'prefs'], accept: [0, 1] }, SILENT)).code === 0;

async function installTailscale(ctx: JoinContext, progress: Progress): Promise<void> {
  const { tailscale } = ctx.pins;
  const arch = archOf(ctx);
  const scratch = await ctx.host.scratch();
  try {
    const archive = path.join(scratch.dir, 'tailscale.tgz');
    await ctx.host.download(`Tailscale ${tailscale.version}`, tailscale.url(arch), archive, tailscale.sha256[arch]);
    await ctx.commands.run({ command: 'tar', args: ['-xzf', archive, '-C', scratch.dir] }, progress);
    const from = path.join(scratch.dir, `tailscale_${tailscale.version}_${arch}`);
    const put = (file: string, mode: string, to: string) => ctx.commands.run({ command: 'install', args: ['-D', '-m', mode, path.join(from, file), ctx.host.at(to)], sudo: true }, progress);
    await put('tailscale', '755', '/usr/bin/tailscale');
    await put('tailscaled', '755', '/usr/sbin/tailscaled');
    await put('systemd/tailscaled.service', '644', '/etc/systemd/system/tailscaled.service');
    if (!await ctx.host.read(TAILSCALE_DEFAULTS).then((there) => there !== undefined)) await put('systemd/tailscaled.defaults', '644', TAILSCALE_DEFAULTS);
  } finally {
    await scratch.remove();
  }
  await daemonReload(ctx, progress);
  await ctx.commands.run({ command: 'systemctl', args: ['enable', '--now', 'tailscaled'], sudo: true }, progress);
  await waitUntil('Tailscale to answer', () => tailscaleAnswers(ctx), async () => {
    const state = (await ctx.commands.run({ command: 'systemctl', args: ['is-failed', 'tailscaled'], accept: [0, 1] }, SILENT)).stdout.trim();
    return state === 'failed' ? 'tailscaled failed to start: journalctl -u tailscaled says why' : undefined;
  });
  progress.line(`Tailscale ${tailscale.version} installed`);
}

export const tailscaleStep = (version: string): Step<JoinContext> => ({
  id: 'tailscale',
  title: `Installing Tailscale ${version}, which Koala reaches this machine through, privately`,
  check: async (ctx) => (await ctx.host.which('tailscale') ? { done: true } : { done: false, why: 'tailscale is not on this machine' }),
  apply: installTailscale,
});

interface Prefs { ControlURL?: unknown; LoggedOut?: unknown; WantRunning?: unknown }

const sameServer = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export async function meshAddress(ctx: JoinContext): Promise<string | undefined> {
  const ran = await ctx.commands.run({ command: 'tailscale', args: ['ip', '-4'], accept: [0, 1] }, SILENT);
  return ran.code === 0 ? ran.stdout.split('\n').map((line) => line.trim()).find(Boolean) : undefined;
}

async function meshState(ctx: JoinContext): Promise<{ done: true } | { done: false; why: string }> {
  const server = joinedOf(ctx).meshLoginServer;
  const prefs = JSON.parse((await ctx.commands.run({ command: 'tailscale', args: ['debug', 'prefs'] }, SILENT)).stdout) as Prefs;
  if (typeof prefs.ControlURL !== 'string' || !sameServer(prefs.ControlURL, server)) return { done: false, why: `Tailscale is not signed in to ${server}` };
  if (prefs.LoggedOut === true || prefs.WantRunning !== true) return { done: false, why: `Tailscale is signed out of ${server}` };
  if (!await meshAddress(ctx)) return { done: false, why: 'Tailscale gives this machine no private address, so Koala could not reach its cluster' };
  return { done: true };
}

async function joinMesh(ctx: JoinContext, progress: Progress): Promise<void> {
  const joined = joinedOf(ctx);
  const scratch = await ctx.host.scratch();
  try {
    const key = path.join(scratch.dir, 'mesh-key');
    await ctx.host.writeOwn(key, joined.meshAuthKey, 0o600);
    await ctx.commands.run({ command: 'tailscale', args: ['up', `--login-server=${joined.meshLoginServer}`, `--auth-key=file:${key}`, '--accept-dns=false'], sudo: true }, progress);
  } finally {
    await scratch.remove();
  }
  const address = await meshAddress(ctx);
  if (address) progress.line(`on the private network as ${address}`);
}

export const meshStep: Step<JoinContext> = {
  id: 'mesh',
  title: 'Joining your private network',
  check: meshState,
  apply: joinMesh,
};
