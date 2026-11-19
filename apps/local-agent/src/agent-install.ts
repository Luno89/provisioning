import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import { ProcessFailed, ProcessNotStarted, type Processes } from '@koala/engine-core/processes';
import { expandHome, type AgentInstall } from './agent-discovery.js';

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
  nodeVersion: string;
}

interface RegistryBinary {
  archive?: unknown;
  cmd?: unknown;
}

interface RegistryEntry {
  name?: unknown;
  version?: unknown;
  distribution?: { binary?: Record<string, RegistryBinary>; npx?: { package?: unknown } };
}

const PLATFORMS: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCHES: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

export const registryTarget = (platform: string, arch: string): string | undefined => {
  const os = PLATFORMS[platform];
  const cpu = ARCHES[arch];
  return os && cpu ? `${os}-${cpu}` : undefined;
};

const tail = (text: string) => text.trim().split('\n').slice(-20).join('\n');

export const systemInstallDeps = (processes: Processes = nodeProcesses): InstallDeps => ({
  fetch: globalThis.fetch,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  unzip: async (archive, into) => {
    const run = { command: 'unzip', args: ['-o', '-q', archive, '-d', into] };
    const result = await processes.run(run).catch((err: unknown) => {
      if (err instanceof ProcessNotStarted && err.code === 'ENOENT') throw new Error('unzip is not installed on this machine');
      throw err;
    });
    if (result.code !== 0) throw new ProcessFailed(run, result);
  },
  npm: async (pkg) => {
    const run = { command: 'npm', args: ['install', '--global', '--engine-strict', pkg], env: passedOn(PERSON_SESSION) };
    const result = await processes.run(run);
    if (result.code !== 0) throw new ProcessFailed(run, result);
    return `${result.stdout}${result.stderr}`;
  },
});

const titleOf = (entry: RegistryEntry, id: string): string => String(entry.name ?? id);

async function binaryFrom(entry: RegistryEntry, binary: RegistryBinary, id: string, into: string, deps: InstallDeps): Promise<InstallOutcome> {
  if (typeof binary.archive !== 'string' || typeof binary.cmd !== 'string') return { ok: false, output: `the registry lists ${id} without an archive and command` };
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
    return { ok: false, output: `installing ${titleOf(entry, id)} failed: ${(err as Error).message}` };
  } finally {
    await rm(archive, { force: true });
  }
  const named = [entry.name ?? id, entry.version].filter((part) => typeof part === 'string' && part).join(' ');
  return { ok: true, output: `Installed ${named} in ${into}` };
}

async function npmFrom(entry: RegistryEntry, pkg: string, id: string, deps: InstallDeps): Promise<InstallOutcome> {
  try {
    const said = tail(await deps.npm(pkg));
    return { ok: true, output: `Installed ${pkg}${said ? `\n${said}` : ''}` };
  } catch (err) {
    const failed = err as Error;
    const said = err instanceof ProcessFailed ? tail(`${err.result.stdout}${err.result.stderr}`) : '';
    const what = err instanceof ProcessFailed ? `${err.run.command} ${err.run.args.join(' ')} exited ${err.result.code}` : failed.message;
    const engine = /EBADENGINE|Unsupported engine/.test(`${what}${said}`)
      ? `${titleOf(entry, id)} needs a newer Node.js than this machine's ${deps.nodeVersion}\n`
      : '';
    return { ok: false, output: `${engine}${what}\n${said}`.trim() };
  }
}

async function fromRegistry(install: AgentInstall, deps: InstallDeps): Promise<InstallOutcome> {
  const id = install.registry;
  const listed = await deps.fetch(`${ACP_REGISTRY}/${id}/agent.json`);
  if (!listed.ok) return { ok: false, output: `the ACP registry has no ${id} (${listed.status})` };
  const entry = await listed.json() as RegistryEntry;
  const target = registryTarget(deps.platform, deps.arch);
  const binary = target ? entry.distribution?.binary?.[target] : undefined;
  if (binary && install.into) return binaryFrom(entry, binary, id, install.into, deps);
  const pkg = entry.distribution?.npx?.package;
  if (typeof pkg === 'string' && pkg) return npmFrom(entry, pkg, id, deps);
  return { ok: false, output: `${titleOf(entry, id)} has no build for ${deps.platform} on ${deps.arch}` };
}

export async function installAgent(install: AgentInstall, deps: InstallDeps = systemInstallDeps()): Promise<InstallOutcome> {
  return fromRegistry(install, deps);
}
