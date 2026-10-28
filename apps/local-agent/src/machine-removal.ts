import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configFile } from './machine-config.js';

const run = promisify(execFile);

export interface Command { file: string; args: string[] }

export function stopServiceCommands(platform: NodeJS.Platform, uid: number, home: string): Command[] {
  if (platform === 'linux') return [{ file: 'systemctl', args: ['--user', 'disable', '--now', 'koala-machine.service'] }];
  if (platform === 'darwin') return [{ file: 'launchctl', args: ['bootout', `gui/${uid}`, path.join(home, 'Library', 'LaunchAgents', 'dev.koala.machine.plist')] }];
  return [];
}

export function serviceFiles(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'linux') return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'koala-machine.service')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'LaunchAgents', 'dev.koala.machine.plist')];
  return [];
}

export async function forgetThisMachine(log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = os.homedir();
  await rm(configFile(env), { force: true });
  log('this machine was removed from Koala: its token is deleted and the agent stops');
  for (const file of serviceFiles(process.platform, env, home)) await rm(file, { force: true }).catch(() => undefined);
  for (const command of stopServiceCommands(process.platform, process.getuid?.() ?? 0, home)) {
    await run(command.file, command.args).catch((err: Error) => log(`${command.file} could not stop the service: ${err.message}`));
  }
}

export async function meshIp(): Promise<string | undefined> {
  const answer = await run('tailscale', ['ip', '-4']).catch(() => undefined);
  return answer?.stdout.split('\n').map((line) => line.trim()).find(Boolean);
}
