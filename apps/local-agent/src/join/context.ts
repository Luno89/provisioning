import path from 'node:path';
import type { CommandRunner, Progress } from '@koala/provision';
import type { JoinArgs } from './args.js';
import type { JoinHost } from './host.js';
import type { Arch, JoinPins } from './pins.js';

export interface Joined {
  rootUrl: string;
  deviceId: string;
  token: string;
  registrationCode: string;
  key: string;
  rootDir: string;
  meshLoginServer: string;
  meshAuthKey: string;
  registry: string;
}

export interface JoinContext {
  args: JoinArgs;
  host: JoinHost;
  commands: CommandRunner;
  pins: JoinPins;
  folder: string;
  agentDir: string;
  node: string;
  joined?: Joined;
}

export const SILENT: Progress = { line: () => undefined };

export function joinedOf(ctx: JoinContext): Joined {
  if (!ctx.joined) throw new Error('this machine has not joined Koala yet in this run, so there is nothing to set up for it');
  return ctx.joined;
}

export function archOf(ctx: JoinContext): Arch {
  if (ctx.host.arch === 'x64' || ctx.host.arch === 'amd64' || ctx.host.arch === 'x86_64') return 'amd64';
  if (ctx.host.arch === 'arm64' || ctx.host.arch === 'aarch64') return 'arm64';
  throw new Error(`this machine is ${ctx.host.arch}, which Koala installs nothing for`);
}

const own = (ctx: JoinContext, kind: 'XDG_DATA_HOME' | 'XDG_CONFIG_HOME', fallback: string): string => ctx.host.env[kind] || path.join(ctx.host.home, fallback);

export const dataHome = (ctx: JoinContext): string => own(ctx, 'XDG_DATA_HOME', path.join('.local', 'share'));
export const configHome = (ctx: JoinContext): string => own(ctx, 'XDG_CONFIG_HOME', '.config');
export const koalaBin = (ctx: JoinContext): string => path.join(dataHome(ctx), 'koala', 'bin');

export async function readRootFile(ctx: JoinContext, file: string): Promise<string | undefined> {
  const there = await ctx.commands.run({ command: 'test', args: ['-e', ctx.host.at(file)], sudo: true, accept: [0, 1] }, SILENT);
  if (there.code !== 0) return undefined;
  return (await ctx.commands.run({ command: 'cat', args: [ctx.host.at(file)], sudo: true }, SILENT)).stdout;
}

export async function putRootFile(ctx: JoinContext, file: string, content: string, mode: string, progress: Progress): Promise<void> {
  const scratch = await ctx.host.scratch();
  try {
    const staged = path.join(scratch.dir, path.basename(file));
    await ctx.host.writeOwn(staged, content, 0o600);
    await ctx.commands.run({ command: 'install', args: ['-D', '-m', mode, staged, ctx.host.at(file)], sudo: true }, progress);
  } finally {
    await scratch.remove();
  }
}

export const daemonReload = (ctx: JoinContext, progress: Progress) => ctx.commands.run({ command: 'systemctl', args: ['daemon-reload'], sudo: true }, progress);
