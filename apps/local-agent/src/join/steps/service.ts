import path from 'node:path';
import type { Progress, Step, StepState } from '@koala/provision';
import { BUNDLE_FILE, LAUNCHD_LABEL, SERVICE_UNIT } from '../../self-update.js';
import { configHome, SILENT, type JoinContext } from '../context.js';

const agentFile = (ctx: JoinContext): string => path.join(ctx.agentDir, 'agent.mjs');

export const unitFile = (ctx: JoinContext): string => path.join(configHome(ctx), 'systemd', 'user', SERVICE_UNIT);

export const unitText = (ctx: JoinContext): string => `[Unit]
Description=Koala machine agent
After=network-online.target

[Service]
ExecStart=${ctx.node} ${agentFile(ctx)}
WorkingDirectory=${ctx.folder}
Environment=PATH=${ctx.host.env.PATH ?? ''}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

export const plistFile = (ctx: JoinContext): string => path.join(ctx.host.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

const LOG = (ctx: JoinContext): string => path.join(ctx.host.home, 'Library', 'Logs', 'koala-machine.log');

export const plistText = (ctx: JoinContext): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${ctx.node}</string><string>${agentFile(ctx)}</string></array>
  <key>WorkingDirectory</key><string>${ctx.folder}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${ctx.host.env.PATH ?? ''}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG(ctx)}</string>
  <key>StandardErrorPath</key><string>${LOG(ctx)}</string>
</dict>
</plist>
`;

async function bundleInstalledAt(ctx: JoinContext): Promise<number> {
  const file = path.join(ctx.agentDir, BUNDLE_FILE);
  const at = await ctx.host.modified(file);
  if (at === undefined) throw new Error(`${file} is not there, so this agent was not installed by the command from My Machines: run that command`);
  return Math.floor(at / 1000);
}

const systemdUser = (ctx: JoinContext, args: string[], accept?: number[]) =>
  ctx.commands.run({ command: 'systemctl', args: ['--user', ...args], ...(accept ? { accept } : {}) }, SILENT);

async function systemdState(ctx: JoinContext): Promise<StepState> {
  if (await ctx.host.readOwn(unitFile(ctx)) !== unitText(ctx)) return { done: false, why: `${unitFile(ctx)} is not the unit Koala writes` };
  const enabled = (await systemdUser(ctx, ['is-enabled', SERVICE_UNIT], [0, 1])).stdout.trim();
  if (enabled !== 'enabled') return { done: false, why: `${SERVICE_UNIT} is ${enabled || 'not enabled'}` };
  const shown = new Map<string, string>((await systemdUser(ctx, ['show', SERVICE_UNIT, '--property=ActiveState,ActiveEnterTimestamp', '--timestamp=unix'])).stdout
    .split('\n').flatMap((line): [string, string][] => {
      const at = line.indexOf('=');
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
    }));
  const active = shown.get('ActiveState') ?? '';
  if (active !== 'active') return { done: false, why: `${SERVICE_UNIT} is ${active || 'not running'}` };
  const since = Number((shown.get('ActiveEnterTimestamp') ?? '').replace(/^@/, ''));
  if (!Number.isFinite(since) || since < await bundleInstalledAt(ctx)) return { done: false, why: `${SERVICE_UNIT} runs the agent from before this one was installed` };
  return { done: true };
}

async function startWithSystemd(ctx: JoinContext, progress: Progress): Promise<void> {
  await ctx.host.writeOwn(unitFile(ctx), unitText(ctx), 0o644);
  const user = (args: string[]) => ctx.commands.run({ command: 'systemctl', args: ['--user', ...args] }, progress);
  await user(['daemon-reload']);
  await user(['enable', SERVICE_UNIT]);
  await user(['restart', SERVICE_UNIT]);
  progress.line('running as the koala-machine service (journalctl --user -u koala-machine to read it)');
  await ctx.commands.run({ command: 'loginctl', args: ['enable-linger', ctx.host.user] }, SILENT).then(
    () => { progress.line('it starts when this machine starts, without you logging in'); },
    () => { progress.line(`It runs while you are logged in. To keep it running after a restart without logging in: sudo loginctl enable-linger ${ctx.host.user}`); },
  );
}

const launchdTarget = (ctx: JoinContext): string => `gui/${ctx.host.uid}`;

async function launchdState(ctx: JoinContext): Promise<StepState> {
  if (await ctx.host.readOwn(plistFile(ctx)) !== plistText(ctx)) return { done: false, why: `${plistFile(ctx)} is not what Koala writes` };
  const printed = await ctx.commands.run({ command: 'launchctl', args: ['print', `${launchdTarget(ctx)}/${LAUNCHD_LABEL}`], accept: [0, 113] }, SILENT);
  const pid = printed.stdout.match(/^\s*pid = (\d+)$/m)?.[1];
  if (printed.code !== 0 || !pid) return { done: false, why: `${LAUNCHD_LABEL} is not running` };
  const started = Date.parse((await ctx.commands.run({ command: 'ps', args: ['-o', 'lstart=', '-p', pid] }, SILENT)).stdout.trim());
  if (!Number.isFinite(started) || Math.floor(started / 1000) < await bundleInstalledAt(ctx)) return { done: false, why: `${LAUNCHD_LABEL} runs the agent from before this one was installed` };
  return { done: true };
}

async function startWithLaunchd(ctx: JoinContext, progress: Progress): Promise<void> {
  await ctx.host.writeOwn(plistFile(ctx), plistText(ctx), 0o644);
  await ctx.host.makeFolder(path.dirname(LOG(ctx)));
  const loaded = await ctx.commands.run({ command: 'launchctl', args: ['print', `${launchdTarget(ctx)}/${LAUNCHD_LABEL}`], accept: [0, 113] }, SILENT);
  if (loaded.code === 0) await ctx.commands.run({ command: 'launchctl', args: ['bootout', launchdTarget(ctx), plistFile(ctx)] }, progress);
  await ctx.commands.run({ command: 'launchctl', args: ['bootstrap', launchdTarget(ctx), plistFile(ctx)] }, progress);
  progress.line(`running as ${LAUNCHD_LABEL} (its log is ~/Library/Logs/koala-machine.log)`);
}

export const systemdServiceStep: Step<JoinContext> = {
  id: 'service',
  title: 'Starting the machine agent, now and whenever you log in',
  check: systemdState,
  apply: startWithSystemd,
};

export const launchdServiceStep: Step<JoinContext> = {
  id: 'service',
  title: 'Starting the machine agent, now and whenever you log in',
  check: launchdState,
  apply: startWithLaunchd,
};
