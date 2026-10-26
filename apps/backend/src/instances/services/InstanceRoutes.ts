import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import tls from 'tls';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { certificateCovers, issuingProblem, nestedSiteOf, wantedRoutes } from '../lib/instance-routes.js';
import type { InstancesStore } from '../store.js';

const execFileAsync = promisify(execFile);

export interface CaddyControl {
  reload(): Promise<void>;
  certificateFor(serverName: string): Promise<string | undefined>;
  recentLog(): Promise<string>;
}

function certificateAt(tlsAddress: string): CaddyControl['certificateFor'] {
  const [host, port] = tlsAddress.split(':') as [string, string];
  return (serverName) => new Promise((resolve) => {
    const socket = tls.connect({ host, port: Number(port), servername: serverName, rejectUnauthorized: false }, () => {
      const san = socket.getPeerCertificate().subjectaltname;
      socket.end();
      resolve(san);
    });
    socket.on('error', () => resolve(undefined));
  });
}

const LOG_TAIL_BYTES = 4 * 1024 * 1024;

async function tailOf(file: string): Promise<string> {
  const handle = await fs.open(file, 'r').catch(() => undefined);
  if (!handle) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export const linesSince = (log: string, sinceSeconds: number): string =>
  log.split('\n').filter((line) => {
    try {
      return (JSON.parse(line) as { ts?: number }).ts! >= sinceSeconds;
    } catch {
      return false;
    }
  }).join('\n');

export function socketCaddy(socket: string, caddyfile: string, logFile: string, tlsAddress: string): CaddyControl {
  return {
    async reload() {
      const body = await fs.readFile(caddyfile);
      await new Promise<void>((resolve, reject) => {
        const request = http.request({
          socketPath: socket, method: 'POST', path: '/load',
          headers: { host: 'caddy', 'content-type': 'text/caddyfile', 'cache-control': 'must-revalidate', 'content-length': body.length },
        }, (response) => {
          let said = '';
          response.on('data', (chunk: Buffer) => { said += chunk.toString(); });
          response.on('end', () => (response.statusCode === 200 ? resolve() : reject(new Error(`Caddy refused the routes (${response.statusCode}): ${said.trim()}`))));
        });
        request.on('error', reject);
        request.end(body);
      });
    },
    certificateFor: certificateAt(tlsAddress),
    async recentLog() {
      return linesSince(await tailOf(logFile), Date.now() / 1000 - 15 * 60);
    },
  };
}

export function dockerCaddy(container: string, tlsAddress: string): CaddyControl {
  return {
    async reload() {
      await execFileAsync('docker', ['exec', container, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--force']);
    },
    certificateFor: certificateAt(tlsAddress),
    async recentLog() {
      const { stdout, stderr } = await execFileAsync('docker', ['logs', '--since', '15m', container], { maxBuffer: 32 * 1024 * 1024 });
      return `${stdout}\n${stderr}`;
    },
  };
}

type Store = Pick<InstancesStore, 'getInstances' | 'saveInstance'>;

export class InstanceRoutes {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly store: Store,
    private readonly domain: string,
    private readonly dir: string,
    private readonly caddy: CaddyControl,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(everyMs = 15_000): void {
    this.changed();
    this.timer = setInterval(() => this.changed(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  changed(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.sync()
      .catch((err: Error) => this.log(`instance routes: ${err.message}`))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.changed();
        }
      });
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async write(folder: string, wanted: Map<string, string>): Promise<boolean> {
    const where = path.join(this.dir, folder);
    await fs.mkdir(where, { recursive: true });
    let touched = false;
    for (const file of await fs.readdir(where)) {
      if (file.endsWith('.caddy') && !wanted.has(file)) {
        await fs.unlink(path.join(where, file));
        touched = true;
      }
    }
    for (const [file, content] of wanted) {
      const current = await fs.readFile(path.join(where, file), 'utf8').catch(() => undefined);
      if (current === content) continue;
      await fs.writeFile(path.join(where, file), content);
      touched = true;
    }
    return touched;
  }

  async sync(): Promise<void> {
    const records = await this.store.getInstances();
    const wanted = wantedRoutes(records, this.domain);
    const handles = await this.write('instances', wanted.handles);
    const sites = await this.write('instance-sites', wanted.sites);
    if (handles || sites) await this.caddy.reload();

    const issuing = records.filter((record) => record.name && record.addresses?.nested && record.addresses.state === 'issuing' && wanted.sites.has(`${record.name}.caddy`));
    if (issuing.length === 0) return;
    const caddyLog = await this.caddy.recentLog().catch(() => '');
    for (const record of issuing) {
      const name = record.name!;
      const served = certificateCovers(await this.caddy.certificateFor(nestedSiteOf(name, this.domain).replace('*', 'koala-probe')), name, this.domain);
      const detail = served ? undefined : issuingProblem(caddyLog, name, this.domain);
      if (served || detail !== record.addresses!.detail) {
        const fresh = (await this.store.getInstances(record.ownerId)).find((entry) => entry.id === record.id);
        if (!fresh?.addresses?.nested || fresh.addresses.state !== 'issuing') continue;
        await this.store.saveInstance({ ...fresh, addresses: { nested: true, state: served ? 'ready' : 'issuing', ...(detail ? { detail } : {}) }, updatedAt: new Date().toISOString() });
      }
    }
  }
}
