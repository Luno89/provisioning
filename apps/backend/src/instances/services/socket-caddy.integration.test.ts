import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linesSince, socketCaddy } from './InstanceRoutes.js';

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function caddyAt(answer: number) {
  const dir = mkdtempSync(join(tmpdir(), 'socket-caddy-'));
  dirs.push(dir);
  const heard: { path?: string | undefined; type?: string | undefined; cache?: string | undefined; body: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      heard.push({ path: request.url, type: request.headers['content-type'], cache: request.headers['cache-control'], body });
      response.statusCode = answer;
      response.end(answer === 200 ? '' : '{"error":"adapting config: bad directive"}');
    });
  });
  servers.push(server);
  const socket = join(dir, 'admin.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const caddyfile = join(dir, 'Caddyfile');
  writeFileSync(caddyfile, '{\n\tadmin unix//run/caddy-admin/admin.sock|0666\n}\n');
  return { dir, socket, caddyfile, heard };
}

describe('reloading root\'s Caddy through its admin socket', () => {
  it('hands Caddy its Caddyfile to adapt and load, even when nothing in it changed', async () => {
    const caddy = await caddyAt(200);
    await socketCaddy(caddy.socket, caddy.caddyfile, join(caddy.dir, 'caddy.log'), '127.0.0.1:1').reload();
    expect(caddy.heard).toEqual([{ path: '/load', type: 'text/caddyfile', cache: 'must-revalidate', body: '{\n\tadmin unix//run/caddy-admin/admin.sock|0666\n}\n' }]);
  });

  it('says what Caddy refused', async () => {
    const caddy = await caddyAt(400);
    await expect(socketCaddy(caddy.socket, caddy.caddyfile, join(caddy.dir, 'caddy.log'), '127.0.0.1:1').reload())
      .rejects.toThrow('Caddy refused the routes (400): {"error":"adapting config: bad directive"}');
  });

  it('reads the last fifteen minutes of its log', async () => {
    const caddy = await caddyAt(200);
    const now = Date.now() / 1000;
    const log = join(caddy.dir, 'caddy.log');
    writeFileSync(log, [JSON.stringify({ ts: now - 3600, msg: 'old' }), 'not json', JSON.stringify({ ts: now - 60, msg: 'rate limited' })].join('\n'));
    expect(await socketCaddy(caddy.socket, caddy.caddyfile, log, '127.0.0.1:1').recentLog()).toBe(JSON.stringify({ ts: now - 60, msg: 'rate limited' }));
    expect(linesSince('', now)).toBe('');
  });
});
