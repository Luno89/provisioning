import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACP_REGISTRY, installAgent, registryTarget, systemInstallDeps, type InstallDeps } from './agent-install.js';

let dir: string;

beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'agent-install-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ARCHIVE = 'https://dl.example.com/agent-1.4.0-linux-x86_64.zip';

const zipped = async (): Promise<Buffer> => {
  const source = path.join(dir, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'agy_acp_server.par'), '#!/bin/sh\necho hi\n');
  const archive = path.join(dir, 'built.zip');
  execFileSync('python3', ['-I', '-m', 'zipfile', '-c', archive, path.join(source, 'agy_acp_server.par')]);
  return readFile(archive);
};

const registryFetch = (entry: unknown, archive: Buffer | undefined, asked: string[]): typeof fetch => (async (input: string | URL | Request) => {
  const url = String(input);
  asked.push(url);
  if (url === `${ACP_REGISTRY}/antigravity-acp/agent.json`) return new Response(JSON.stringify(entry));
  if (url === ARCHIVE && archive) return new Response(new Uint8Array(archive));
  return new Response('missing', { status: 404 });
}) as typeof fetch;

const entry = {
  name: 'Google Antigravity',
  version: '1.4.0',
  distribution: { binary: { 'linux-x86_64': { archive: ARCHIVE, cmd: './agy_acp_server.par', args: ['--uid='] } } },
};

const deps = (fetchFn: typeof fetch, platform = 'linux', arch = 'x64'): InstallDeps => ({
  ...systemInstallDeps(),
  fetch: fetchFn,
  platform,
  arch,
  npm: async () => { throw new Error('npm must not be asked'); },
});

describe('installing an agent a machine lacks', () => {
  it('names registry builds the way the ACP registry does', () => {
    expect(registryTarget('linux', 'x64')).toBe('linux-x86_64');
    expect(registryTarget('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(registryTarget('aix', 'ppc64')).toBeUndefined();
  });

  it('downloads the build the registry lists for this machine and leaves its command runnable', async () => {
    const asked: string[] = [];
    const into = path.join(dir, 'agents', 'antigravity-acp');
    const outcome = await installAgent({ registry: 'antigravity-acp', into }, deps(registryFetch(entry, await zipped(), asked)));
    expect(outcome).toEqual({ ok: true, output: `Installed Google Antigravity 1.4.0 in ${into}` });
    expect(asked).toEqual([`${ACP_REGISTRY}/antigravity-acp/agent.json`, ARCHIVE]);
    await access(path.join(into, 'agy_acp_server.par'), constants.X_OK);
    expect(await readdir(path.join(dir, 'agents'))).toEqual(['antigravity-acp']);
  });

  it('keeps what was installed before when the download fails', async () => {
    const into = path.join(dir, 'agents', 'antigravity-acp');
    await mkdir(into, { recursive: true });
    await writeFile(path.join(into, 'agy_acp_server.par'), 'old');
    const outcome = await installAgent({ registry: 'antigravity-acp', into }, deps(registryFetch(entry, undefined, [])));
    expect(outcome).toEqual({ ok: false, output: `downloading ${ARCHIVE} failed (404)` });
    expect(await readFile(path.join(into, 'agy_acp_server.par'), 'utf8')).toBe('old');
  });

  it('says so when the registry has no build for this machine, and downloads nothing', async () => {
    const asked: string[] = [];
    const outcome = await installAgent({ registry: 'antigravity-acp', into: path.join(dir, 'a') }, deps(registryFetch(entry, undefined, asked), 'darwin', 'arm64'));
    expect(outcome).toEqual({ ok: false, output: 'Google Antigravity has no build for darwin on arm64' });
    expect(asked).toHaveLength(1);
  });

  it('installs an npm adapter through npm and reports what it said', async () => {
    const installed: string[] = [];
    const outcome = await installAgent({ npm: '@zed-industries/claude-code-acp' }, { ...deps(registryFetch(entry, undefined, [])), npm: async (pkg) => { installed.push(pkg); return 'added 12 packages\n'; } });
    expect(outcome).toEqual({ ok: true, output: 'added 12 packages' });
    expect(installed).toEqual(['@zed-industries/claude-code-acp']);
  });
});
