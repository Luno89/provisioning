import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostFromVm } from './image-cache.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const UPSTREAM = 'https://github.com/k3s-io/k3s/releases/download';

export interface K3sPin { version: string; sha256: string }

export function pinnedK3s(pinsFile = join(REPO, 'dependencies.pins.json')): K3sPin {
  const pins = JSON.parse(readFileSync(pinsFile, 'utf8')) as { components: Array<{ name: string; version: string; sha256s?: Record<string, string> }> };
  const k3s = pins.components.find((component) => component.name === 'k3s');
  const sha256 = k3s?.sha256s?.['linux-amd64'];
  if (!k3s || !sha256) throw new Error('dependencies.pins.json pins no k3s binary for linux-amd64');
  return { version: k3s.version, sha256 };
}

export const releasePath = (version: string) => `/${version.replace(/\+/g, '%2B')}/k3s`;

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function cachedK3s(pin: K3sPin, dir = join(homedir(), '.cache', 'koala', 'k3s'), fetchK3s: (url: string) => Promise<Buffer> = async (url) => {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return Buffer.from(await answer.arrayBuffer());
}): Promise<string> {
  const file = join(dir, pin.version, 'k3s');
  if (existsSync(file) && sha256Of(readFileSync(file)) === pin.sha256) return file;
  const bytes = await fetchK3s(`${UPSTREAM}${releasePath(pin.version)}`);
  if (sha256Of(bytes) !== pin.sha256) throw new Error(`the k3s ${pin.version} downloaded is not the one dependencies.pins.json pins`);
  mkdirSync(join(dir, pin.version), { recursive: true });
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
  return file;
}

export interface K3sMirror { url: string; close(): Promise<void> }

export async function serveK3s(file: string, version: string, guestHost = hostFromVm()): Promise<K3sMirror> {
  const path = releasePath(version);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== path) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://${guestHost}:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

export async function k3sMirror(guestHost?: string): Promise<K3sMirror> {
  const pin = pinnedK3s();
  return serveK3s(await cachedK3s(pin), pin.version, guestHost);
}
