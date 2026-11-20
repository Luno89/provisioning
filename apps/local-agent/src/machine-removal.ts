import { passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { ignore } from '@koala/engine-core/failures';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import type { Processes } from '@koala/engine-core/processes';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configFile } from './machine-config.js';
import { K3S_UNINSTALL, uninstallMachineCluster, type ClusterHost } from './machine-cluster.js';

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

export async function forgetThisMachine(log: (line: string) => void, env: NodeJS.ProcessEnv = process.env, processes: Processes = nodeProcesses): Promise<void> {
  const home = os.homedir();
  await rm(configFile(env), { force: true });
  log('this machine was removed from Koala: its token is deleted and the agent stops');
  for (const file of serviceFiles(process.platform, env, home)) await rm(file, { force: true }).catch((err: Error) => log(`${file} could not be removed, so the service may start the agent again: ${err.message}`));
  for (const command of stopServiceCommands(process.platform, process.getuid?.() ?? 0, home)) {
    const stopped = await processes.run({ command: command.file, args: command.args, env: passedOn(PERSON_SESSION) }).then(
      (result) => (result.code === 0 ? undefined : `exited ${result.code}: ${(result.stderr || result.stdout).trim()}`),
      (err: Error) => err.message,
    );
    if (stopped !== undefined) log(`${command.file} could not stop the service: ${stopped}`);
  }
}

export async function removeThisMachine(host: ClusterHost, forget: () => Promise<void>, log: (line: string) => void): Promise<void> {
  try {
    await uninstallMachineCluster(host, log);
  } finally {
    await host.letKoalaGo();
    await forget();
  }
  if (await host.exists(K3S_UNINSTALL)) throw new Error(`k3s is still on this machine: ${K3S_UNINSTALL} did not remove it`);
}

export async function meshIp(processes: Processes = nodeProcesses): Promise<string | undefined> {
  const answer = await processes.run({ command: 'tailscale', args: ['ip', '-4'] }).catch(ignore('a machine where tailscale is missing or signed out is not on the mesh, which is what no address says'));
  return answer?.code === 0 ? answer.stdout.split('\n').map((line) => line.trim()).find(Boolean) : undefined;
}
