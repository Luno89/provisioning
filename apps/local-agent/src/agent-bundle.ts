import { ignore } from '@koala/engine-core/failures';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { BUNDLE_FILE, bundleIn } from './self-update.js';

const exec = promisify(execFile);

export interface BundlePlace {
  dir: string;
  next: string;
  previous: string;
}

export const placeOf = (dir: string): BundlePlace => ({ dir, next: `${dir}.next`, previous: `${dir}.previous` });

export function ownBundle(dir: string): string | undefined {
  try {
    return bundleIn(readFileSync(path.join(dir, BUNDLE_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

export function ownVersion(dir: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

export type Run = (file: string, args: string[], cwd: string) => Promise<string>;

const realRun: Run = async (file, args, cwd) => {
  try {
    return (await exec(file, args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (err) {
    const failed = err as Error & { stderr?: string; stdout?: string };
    const lines = (failed.stderr || failed.stdout || failed.message).split('\n').map((line) => line.trim()).filter(Boolean);
    const said = lines.find((line) => /^(\w*Error\b|npm (ERR|error)\b|tar: )/.test(line)) ?? lines.slice(-3).join(' ');
    throw new Error(`${[path.basename(file), ...args.slice(0, 1).map((arg) => path.basename(arg))].join(' ')} failed: ${said}`);
  }
};

export async function downloadBundle(url: string, to: string, fetcher: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (err) {
    throw new Error(`the agent could not be downloaded from ${url}: ${(err as Error).message}`);
  }
  if (!response.ok || !response.body) throw new Error(`Koala answered ${response.status} when asked for the agent at ${url}`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  await pipeline(body, async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(to));
  return hash.digest('hex');
}

export interface PrepareOptions {
  place: BundlePlace;
  bundle: string;
  url: string;
  node: string;
  npm?: string | undefined;
  run?: Run | undefined;
  fetcher?: typeof fetch | undefined;
}

export async function prepareBundle(options: PrepareOptions): Promise<void> {
  const { place, bundle } = options;
  const run = options.run ?? realRun;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-agent-'));
  try {
    const tarball = path.join(scratch, 'agent.tgz');
    const got = await downloadBundle(options.url, tarball, options.fetcher);
    if (got !== bundle) throw new Error(`the agent Koala sent is not the one it named (its sha256 is ${got.slice(0, 12)}, Koala named ${bundle.slice(0, 12)})`);
    try {
      await rm(place.next, { recursive: true, force: true });
      await mkdir(place.next, { recursive: true });
    } catch (err) {
      throw new Error(`there is no room for the new agent at ${place.next}: ${(err as Error).message}`);
    }
    try {
      await run('tar', ['-xzf', tarball, '-C', place.next], place.next);
      await run(options.npm ?? 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], place.next);
      await writeFile(path.join(place.next, BUNDLE_FILE), `${bundle}\n`);
      const said = await run(options.node, [path.join(place.next, 'agent.mjs'), 'version'], place.next);
      const started = versionSaid(said);
      if (started?.bundle !== bundle) throw new Error(`the new agent did not start as itself: it said ${said.trim().slice(0, 200) || 'nothing'}`);
    } catch (err) {
      await rm(place.next, { recursive: true, force: true }).catch(ignore('the next update empties this folder before it unpacks into it'));
      throw err;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function versionSaid(said: string): { bundle?: string; version?: string } | undefined {
  const line = said.trim().split('\n').pop();
  try {
    const parsed = JSON.parse(line ?? '') as { bundle?: unknown; version?: unknown };
    return {
      ...(typeof parsed.bundle === 'string' ? { bundle: parsed.bundle } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
    };
  } catch {
    return undefined;
  }
}

export function swapBundle(place: BundlePlace): void {
  rmSync(place.previous, { recursive: true, force: true });
  renameSync(place.dir, place.previous);
  try {
    renameSync(place.next, place.dir);
  } catch (err) {
    renameSync(place.previous, place.dir);
    throw err;
  }
}

export async function discardBundle(place: BundlePlace): Promise<void> {
  await rm(place.next, { recursive: true, force: true });
}

export async function readCgroup(): Promise<string | undefined> {
  return readFile('/proc/self/cgroup', 'utf8').catch(ignore('only Linux has /proc/self/cgroup, and without it no systemd service is running this agent'));
}
