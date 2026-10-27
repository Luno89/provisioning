import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function folderProblem(folder: string, home: string): string | undefined {
  const resolved = path.resolve(folder);
  const homeDir = path.resolve(home);
  if (resolved === path.parse(resolved).root || resolved === homeDir || homeDir.startsWith(`${resolved}${path.sep}`)) {
    return `Koala works in a folder of its own, never ${resolved}, which holds everything else on this machine: pick a folder inside it, like ${path.join(homeDir, 'koala')}`;
  }
  return undefined;
}

export interface MachineConfig {
  backendUrl: string;
  token: string;
  rootDir: string;
  deviceId?: string | undefined;
  temporalAddress?: string | undefined;
  temporalNamespace?: string | undefined;
}

export const configFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env.KOALA_MACHINE_CONFIG ?? path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'koala', 'machine.json');

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export function machineConfigFrom(env: NodeJS.ProcessEnv, saved: Record<string, unknown>, cwd: string): MachineConfig {
  const backendUrl = text(env.KOALA_BACKEND_URL) ?? text(saved.backendUrl);
  const token = text(env.KOALA_DEVICE_TOKEN) ?? text(saved.token);
  if (!backendUrl) throw new Error('this machine has no Koala to connect to: run the command from My Machines, or set KOALA_BACKEND_URL');
  if (!token) throw new Error('this machine has no device token: run the command from My Machines, or set KOALA_DEVICE_TOKEN');
  const deviceId = text(env.KOALA_DEVICE_ID) ?? text(saved.deviceId);
  const temporalAddress = text(env.KOALA_TEMPORAL_ADDRESS) ?? text(saved.temporalAddress);
  const temporalNamespace = text(env.KOALA_TEMPORAL_NAMESPACE) ?? text(saved.temporalNamespace);
  const rootDir = path.resolve(text(env.KOALA_ROOT_DIR) ?? text(saved.rootDir) ?? cwd);
  const tooWide = folderProblem(rootDir, os.homedir());
  if (tooWide) throw new Error(tooWide);
  return {
    backendUrl,
    token,
    rootDir,
    ...(deviceId ? { deviceId } : {}),
    ...(temporalAddress ? { temporalAddress } : {}),
    ...(temporalNamespace ? { temporalNamespace } : {}),
  };
}

export async function loadMachineConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<MachineConfig> {
  const saved = await readFile(configFile(env), 'utf8').then(
    (raw) => JSON.parse(raw) as Record<string, unknown>,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return {};
      throw new Error(`${configFile(env)} could not be read: ${err.message}`);
    },
  );
  return machineConfigFrom(env, saved, cwd);
}
