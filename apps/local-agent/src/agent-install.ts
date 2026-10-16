import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { expandHome, type AgentInstall } from './agent-discovery.js';

const run = promisify(execFile);

export const ACP_REGISTRY = 'https://raw.githubusercontent.com/agentclientprotocol/registry/main';

export interface InstallOutcome {
  ok: boolean;
  output: string;
}

export interface InstallDeps {
  fetch: typeof fetch;
  platform: string;
  arch: string;
  unzip(archive: string, into: string): Promise<void>;
  npm(pkg: string): Promise<string>;
}

interface RegistryBinary {
  archive?: unknown;
  cmd?: unknown;
}

const PLATFORMS: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCHES: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

export const registryTarget = (platform: string, arch: string): string | undefined => {
  const os = PLATFORMS[platform];
  const cpu = ARCHES[arch];
  return os && cpu ? `${os}-${cpu}` : undefined;
};

const tail = (text: string) => text.trim().split('\n').slice(-20).join('\n');

export const systemInstallDeps = (): InstallDeps => ({
  fetch: globalThis.fetch,
  platform: process.platform,
  arch: process.arch,
  unzip: async (archive, into) => {
    await run('unzip', ['-o', '-q', archive, '-d', into]).catch((err: NodeJS.ErrnoException) => {
      throw new Error(err.code === 'ENOENT' ? 'unzip is not installed on this machine' : err.message);
    });
  },
  npm: async (pkg) => {
    const { stdout, stderr } = await run('npm', ['install', '--global', pkg], { maxBuffer: 16 * 1024 * 1024 });
    return `${stdout}${stderr}`;
  },
});

async function fromRegistry(id: string, into: string, deps: InstallDeps): Promise<InstallOutcome> {
  const listed = await deps.fetch(`${ACP_REGISTRY}/${id}/agent.json`);
  if (!listed.ok) return { ok: false, output: `the ACP registry has no ${id} (${listed.status})` };
  const entry = await listed.json() as { name?: unknown; version?: unknown; distribution?: { binary?: Record<string, RegistryBinary> } };
  const target = registryTarget(deps.platform, deps.arch);
  const binary = target ? entry.distribution?.binary?.[target] : undefined;
  if (!target || typeof binary?.archive !== 'string' || typeof binary.cmd !== 'string') {
    return { ok: false, output: `${String(entry.name ?? id)} has no build for ${deps.platform} on ${deps.arch}` };
  }
  if (!binary.archive.startsWith('https://')) return { ok: false, output: `the registry lists ${id} at an address that is not https` };
  const home = expandHome(into);
  const next = `${home}.next`;
  const archive = `${home}.zip`;
  await rm(next, { recursive: true, force: true });
  await mkdir(path.dirname(home), { recursive: true });
  try {
    const download = await deps.fetch(binary.archive);
    if (!download.ok || !download.body) return { ok: false, output: `downloading ${binary.archive} failed (${download.status})` };
    await pipeline(Readable.fromWeb(download.body as import('node:stream/web').ReadableStream), createWriteStream(archive));
    await mkdir(next, { recursive: true });
    await deps.unzip(archive, next);
    const command = path.join(next, binary.cmd);
    await chmod(command, 0o755);
    await rm(home, { recursive: true, force: true });
    await rename(next, home);
  } catch (err) {
    await rm(next, { recursive: true, force: true });
    return { ok: false, output: `installing ${String(entry.name ?? id)} failed: ${(err as Error).message}` };
  } finally {
    await rm(archive, { force: true });
  }
  const named = [entry.name ?? id, entry.version].filter((part) => typeof part === 'string' && part).join(' ');
  return { ok: true, output: `Installed ${named} in ${into}` };
}

export async function installAgent(install: AgentInstall, deps: InstallDeps = systemInstallDeps()): Promise<InstallOutcome> {
  if ('npm' in install) {
    try {
      return { ok: true, output: tail(await deps.npm(install.npm)) };
    } catch (err) {
      const failed = err as Error & { stdout?: string; stderr?: string };
      return { ok: false, output: `${failed.message}\n${tail(`${failed.stdout ?? ''}${failed.stderr ?? ''}`)}`.trim() };
    }
  }
  return fromRegistry(install.registry, install.into, deps);
}
