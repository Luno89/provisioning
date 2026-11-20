import path from 'node:path';
import type { Progress, Step, StepState } from '@koala/provision';
import { K3S_BINARY, K3S_KILLALL, K3S_MARKER, K3S_UNINSTALL } from '../../machine-cluster.js';
import { archOf, daemonReload, joinedOf, putRootFile, readRootFile, type JoinContext } from '../context.js';
import { K3S_CONFIG, K3S_FIREWALL, K3S_FIREWALL_DROPIN, K3S_FIREWALL_SCRIPT, K3S_FIREWALL_UNIT, K3S_NODE_PORTS, K3S_NODE_PORTS_FILE, K3S_REGISTRIES, K3S_SUDOERS, K3S_UNIT, k3sConfig, MACHINE_UNINSTALL_SCRIPT, sudoRule, withMirror } from '../k3s-files.js';
import { meshAddress } from './mesh.js';

interface Wanted { file: string; content: string; mode: string }

const DONE: StepState = { done: true };

async function differing(ctx: JoinContext, wanted: readonly Wanted[]): Promise<Wanted[]> {
  const off: Wanted[] = [];
  for (const file of wanted) if (await ctx.host.read(file.file) !== file.content) off.push(file);
  return off;
}

const filesState = async (ctx: JoinContext, wanted: readonly Wanted[]): Promise<StepState> => {
  const off = await differing(ctx, wanted);
  return off.length === 0 ? DONE : { done: false, why: `${off.map((file) => file.file).join(', ')} ${off.length === 1 ? 'is' : 'are'} not what Koala writes` };
};

const putAll = async (ctx: JoinContext, wanted: readonly Wanted[], progress: Progress): Promise<void> => {
  for (const file of await differing(ctx, wanted)) await putRootFile(ctx, file.file, file.content, file.mode, progress);
};

async function configWanted(ctx: JoinContext): Promise<Wanted[]> {
  const meshIp = await meshAddress(ctx);
  if (!meshIp) throw new Error('Tailscale gives this machine no private address, so Koala could not reach its cluster');
  const registries = Object.entries(ctx.args.imageMirrors).reduce(
    (now, [registry, endpoint]) => withMirror(now, registry, endpoint),
    withMirror(await ctx.host.read(K3S_REGISTRIES), joinedOf(ctx).registry),
  );
  return [
    { file: K3S_CONFIG, content: k3sConfig(meshIp, ctx.host.group), mode: '644' },
    { file: K3S_NODE_PORTS_FILE, content: K3S_NODE_PORTS, mode: '644' },
    ...(registries !== undefined ? [{ file: K3S_REGISTRIES, content: registries, mode: '644' }] : []),
  ];
}

export const k3sConfigStep: Step<JoinContext> = {
  id: 'k3s-config',
  title: 'Writing k3s\'s settings: its private address, node ports on this machine and your private network only, and root\'s registry',
  check: async (ctx) => filesState(ctx, await configWanted(ctx)),
  apply: async (ctx, progress) => putAll(ctx, await configWanted(ctx), progress),
};

const FIREWALL: Wanted[] = [
  { file: K3S_FIREWALL, content: K3S_FIREWALL_SCRIPT, mode: '755' },
  { file: K3S_FIREWALL_DROPIN, content: K3S_FIREWALL_UNIT, mode: '644' },
];

export const k3sFirewallStep: Step<JoinContext> = {
  id: 'k3s-firewall',
  title: 'Closing k3s\'s ports to every network but this machine and your private network',
  check: (ctx) => filesState(ctx, FIREWALL),
  apply: async (ctx, progress) => {
    await putAll(ctx, FIREWALL, progress);
    await daemonReload(ctx, progress);
  },
};

const UNINSTALL: Wanted[] = [{ file: K3S_UNINSTALL, content: MACHINE_UNINSTALL_SCRIPT, mode: '755' }];

export const k3sUninstallStep: Step<JoinContext> = {
  id: 'k3s-uninstall',
  title: 'Writing how removing this machine uninstalls what the join installs',
  check: (ctx) => filesState(ctx, UNINSTALL),
  apply: (ctx, progress) => putAll(ctx, UNINSTALL, progress),
};

async function k3sState(ctx: JoinContext): Promise<StepState> {
  const marker = (await ctx.host.read(K3S_MARKER))?.trim();
  if (marker !== ctx.pins.k3s.version) return { done: false, why: marker ? `this machine has Koala's k3s ${marker}, not ${ctx.pins.k3s.version}` : `k3s ${ctx.pins.k3s.version} is not installed` };
  for (const file of [K3S_BINARY, K3S_KILLALL]) if (!await ctx.host.executable(file)) return { done: false, why: `${file} is not there` };
  if (await ctx.host.read(K3S_UNIT) === undefined) return { done: false, why: `${K3S_UNIT} is not there` };
  return DONE;
}

async function installK3s(ctx: JoinContext, progress: Progress): Promise<void> {
  const { k3s, k3sInstaller } = ctx.pins;
  const arch = archOf(ctx);
  const scratch = await ctx.host.scratch();
  try {
    const installer = path.join(scratch.dir, 'install.sh');
    const binary = path.join(scratch.dir, 'k3s');
    await ctx.host.download('the k3s installer', k3sInstaller.url, installer, k3sInstaller.sha256);
    await ctx.host.download(`k3s ${k3s.version}`, k3s.url(arch), binary, k3s.sha256[arch]);
    await putRootFile(ctx, K3S_MARKER, `${k3s.version}\n`, '644', progress);
    await ctx.commands.run({ command: 'install', args: ['-D', '-m', '755', binary, ctx.host.at(K3S_BINARY)], sudo: true }, progress);
    await ctx.commands.run({
      command: 'sh',
      args: [installer],
      sudo: true,
      env: { INSTALL_K3S_SKIP_DOWNLOAD: 'true', INSTALL_K3S_VERSION: k3s.version, INSTALL_K3S_SKIP_START: 'true', INSTALL_K3S_SKIP_ENABLE: 'true' },
    }, progress);
  } finally {
    await scratch.remove();
  }
  await daemonReload(ctx, progress);
  progress.line(`k3s ${k3s.version} installed, stopped until Koala has work here; it answers only on this machine and your private network`);
}

export const k3sStep = (version: string): Step<JoinContext> => ({
  id: 'k3s',
  title: `Installing k3s ${version}, started only while there is work`,
  check: k3sState,
  apply: installK3s,
});

const ruleWanted = async (ctx: JoinContext): Promise<string> => {
  const systemctl = await ctx.host.which('systemctl');
  if (!systemctl) throw new Error('systemctl is not on this machine, and k3s is started and stopped through it');
  return sudoRule(ctx.host.user, systemctl);
};

export const k3sSudoStep: Step<JoinContext> = {
  id: 'k3s-sudo',
  title: 'Letting the machine agent start and stop k3s without asking for your password',
  check: async (ctx) => (await readRootFile(ctx, K3S_SUDOERS) === await ruleWanted(ctx) ? DONE : { done: false, why: `${K3S_SUDOERS} does not hold the rule Koala writes` }),
  apply: async (ctx, progress) => {
    const rule = await ruleWanted(ctx);
    const scratch = await ctx.host.scratch();
    try {
      const staged = path.join(scratch.dir, 'koala-k3s');
      await ctx.host.writeOwn(staged, rule, 0o600);
      await ctx.commands.run({ command: 'visudo', args: ['-cf', staged], sudo: true }, progress).catch((err: Error) => {
        throw new Error(`the sudo rule for starting k3s did not check out, so nothing was changed in sudoers: ${err.message}`, { cause: err });
      });
      await ctx.commands.run({ command: 'install', args: ['-D', '-m', '440', staged, ctx.host.at(K3S_SUDOERS)], sudo: true }, progress);
    } finally {
      await scratch.remove();
    }
  },
};
