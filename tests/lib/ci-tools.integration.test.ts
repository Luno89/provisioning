import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { until, waiting } from './until.js';

const run = promisify(execFile);
const SCRIPTS = resolve(import.meta.dirname, '..', '..', 'scripts');
const TOOL = '#!/usr/bin/env bash\necho "the tool ran"\n';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function aRepoPinning(url: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ci-tools-'));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));
  await mkdir(join(repo, 'scripts'));
  await copyFile(join(SCRIPTS, 'ci-tools.sh'), join(repo, 'scripts', 'ci-tools.sh'));
  await copyFile(join(SCRIPTS, 'pin.mjs'), join(repo, 'scripts', 'pin.mjs'));
  const sha256 = createHash('sha256').update(TOOL).digest('hex');
  await writeFile(join(repo, 'dependencies.pins.json'), JSON.stringify({ components: [{ name: 'the-tool', version: '1.0.0', sha256, source: url, fetch: 'binary', ciTool: true }] }));
  await run('git', ['init', '-q', repo]);
  return repo;
}

function aServerHoldingTheFirstDownload(): Promise<{ url: string; requests: () => number; release: () => void }> {
  let requests = 0;
  const held: ServerResponse[] = [];
  let released = false;
  const server: Server = createServer((_request, response) => {
    requests += 1;
    if (released) response.end(TOOL);
    else held.push(response);
  });
  cleanups.push(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return new Promise((done) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    done({
      url: `http://127.0.0.1:${port}/the-tool`,
      requests: () => requests,
      release: () => { released = true; for (const response of held.splice(0)) response.end(TOOL); },
    });
  }));
}

async function descendantsOf(roots: readonly number[]): Promise<string[]> {
  const { stdout } = await run('ps', ['-e', '-o', 'pid=,ppid=,comm=']);
  const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/)).map(([pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm: comm ?? '' }));
  const inTree = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) if (!inTree.has(row.pid) && inTree.has(row.ppid)) { inTree.add(row.pid); grew = true; }
  }
  return rows.filter((row) => inTree.has(row.pid) && !roots.includes(row.pid)).map((row) => row.comm);
}

function aCaller(repo: string): { child: ChildProcess; ended: Promise<{ code: number | null; out: string; err: string }> } {
  const child = spawn('bash', [join(repo, 'scripts', 'ci-tools.sh'), 'the-tool'], { cwd: repo, env: { ...process.env, CI_TOOLS: join(repo, '.ci-tools') } });
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk: Buffer) => { out += String(chunk); });
  child.stderr!.on('data', (chunk: Buffer) => { err += String(chunk); });
  return { child, ended: new Promise((done) => child.on('exit', (code) => done({ code, out: out.trim(), err }))) };
}

describe('fetching a pinned test tool', () => {
  it('downloads it once when several test files ask for it at the same time, and every one of them gets a tool that runs', async () => {
    const server = await aServerHoldingTheFirstDownload();
    const repo = await aRepoPinning(server.url);
    const callers = Array.from({ length: 4 }, () => aCaller(repo));
    cleanups.push(async () => { for (const { child } of callers) child.kill(); });
    const pids = callers.map(({ child }) => child.pid!);

    await until('every caller is downloading or waiting its turn', async () => {
      const busy = (await descendantsOf(pids)).filter((comm) => comm === 'curl' || comm === 'flock');
      return busy.length >= callers.length ? true : waiting(`${busy.length} of ${callers.length} callers are downloading or waiting`);
    });
    server.release();
    const results = await Promise.all(callers.map(({ ended }) => ended));

    expect(server.requests()).toBe(1);
    for (const result of results) {
      expect(result).toMatchObject({ code: 0, out: join(repo, '.ci-tools', 'the-tool') });
      expect((await run(result.out, [])).stdout.trim()).toBe('the tool ran');
    }
  });
});
