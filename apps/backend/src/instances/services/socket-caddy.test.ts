import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type tls from 'node:tls';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { linesSince, socketCaddy, type CaddyAdminTransport } from './InstanceRoutes.js';

interface Heard { options: http.RequestOptions; body: string }

function caddyAnswering(status: number, said: string) {
  const heard: Heard[] = [];
  const request = ((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: (body: Buffer) => void };
    outgoing.end = (body) => {
      heard.push({ options, body: body.toString() });
      if (status === 0) {
        outgoing.emit('error', new Error('connect ENOENT /run/caddy-admin/admin.sock'));
        return;
      }
      callback(Object.assign(Readable.from([Buffer.from(said)]), { statusCode: status }) as unknown as http.IncomingMessage);
    };
    return outgoing;
  }) as unknown as typeof http.request;
  return { heard, transport: { request, connect: (() => { throw new Error('this one does not dial'); }) as unknown as typeof tls.connect } satisfies CaddyAdminTransport };
}

function folder(): { dir: string; caddyfile: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'socket-caddy-'));
  const caddyfile = join(dir, 'Caddyfile');
  writeFileSync(caddyfile, '{\n\tadmin unix//run/caddy-admin/admin.sock|0666\n}\n');
  return { dir, caddyfile, log: join(dir, 'caddy.log') };
}

describe('reloading root\'s Caddy through its admin socket', () => {
  it('hands Caddy its Caddyfile to adapt and load, even when nothing in it changed', async () => {
    const { caddyfile, log, dir } = folder();
    const caddy = caddyAnswering(200, '');
    await socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:1', caddy.transport).reload();
    expect(caddy.heard).toHaveLength(1);
    expect(caddy.heard[0]!.options).toMatchObject({
      socketPath: join(dir, 'admin.sock'), method: 'POST', path: '/load',
      headers: { host: 'caddy', 'content-type': 'text/caddyfile', 'cache-control': 'must-revalidate' },
    });
    expect(caddy.heard[0]!.body).toBe('{\n\tadmin unix//run/caddy-admin/admin.sock|0666\n}\n');
  });

  it('says what Caddy refused', async () => {
    const { caddyfile, log, dir } = folder();
    const caddy = caddyAnswering(400, '{"error":"adapting config: bad directive"}');
    await expect(socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:1', caddy.transport).reload())
      .rejects.toThrow('Caddy refused the routes (400): {"error":"adapting config: bad directive"}');
  });

  it('fails when the admin socket cannot be reached', async () => {
    const { caddyfile, log, dir } = folder();
    const caddy = caddyAnswering(0, '');
    await expect(socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:1', caddy.transport).reload()).rejects.toThrow('ENOENT');
  });
});

describe('what root reads of Caddy\'s log', () => {
  const nothing = caddyAnswering(200, '').transport;

  it('reads the last fifteen minutes of it', async () => {
    const { caddyfile, log, dir } = folder();
    const now = Date.now() / 1000;
    writeFileSync(log, [JSON.stringify({ ts: now - 3600, msg: 'old' }), 'not json', JSON.stringify({ ts: now - 60, msg: 'rate limited' })].join('\n'));
    expect(await socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:1', nothing).recentLog()).toBe(JSON.stringify({ ts: now - 60, msg: 'rate limited' }));
  });

  it('has nothing to read before Caddy has logged anything', async () => {
    const { caddyfile, log, dir } = folder();
    expect(await socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:1', nothing).recentLog()).toBe('');
  });

  it('reads only the last few megabytes of a very long log', async () => {
    const { caddyfile, log, dir } = folder();
    const now = Date.now() / 1000;
    const recent = JSON.stringify({ ts: now - 10, msg: 'recent' });
    writeFileSync(log, `${JSON.stringify({ ts: now - 5, msg: 'cut off' }).padEnd(5 * 1024 * 1024, ' ')}\n${recent}`);
    expect(await socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:1', nothing).recentLog()).toBe(recent);
  });

  it('fails on a log it may not read, rather than calling it empty', async () => {
    const { caddyfile, dir } = folder();
    await expect(socketCaddy(join(dir, 'admin.sock'), caddyfile, dir, '127.0.0.1:1', nothing).recentLog()).rejects.toThrow();
  });

  it('keeps the lines at or after a moment and drops the rest', () => {
    const log = [JSON.stringify({ ts: 5 }), JSON.stringify({ ts: 10 }), 'plain text', JSON.stringify({ msg: 'no time' })].join('\n');
    expect(linesSince(log, 10)).toBe(JSON.stringify({ ts: 10 }));
    expect(linesSince('', 0)).toBe('');
  });
});

describe('asking Caddy which certificate it serves', () => {
  function dialing(answer: { san: string | undefined } | Error) {
    const dialed: tls.ConnectionOptions[] = [];
    const connect = ((options: tls.ConnectionOptions, onSecure: () => void) => {
      dialed.push(options);
      const socket = new EventEmitter() as EventEmitter & { getPeerCertificate: () => { subjectaltname: string | undefined }; end: () => void; ended: boolean };
      socket.ended = false;
      socket.end = () => { socket.ended = true; };
      socket.getPeerCertificate = () => ({ subjectaltname: answer instanceof Error ? undefined : answer.san });
      queueMicrotask(() => (answer instanceof Error ? socket.emit('error', answer) : onSecure()));
      return socket;
    }) as unknown as typeof tls.connect;
    return { dialed, transport: { request: caddyAnswering(200, '').transport.request, connect } satisfies CaddyAdminTransport };
  }

  it('connects to Caddy naming the site and returns the names its certificate covers', async () => {
    const { caddyfile, log, dir } = folder();
    const rig = dialing({ san: 'DNS:*.luno.koala.dev' });
    expect(await socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:8443', rig.transport).certificateFor('koala-probe.luno.koala.dev')).toBe('DNS:*.luno.koala.dev');
    expect(rig.dialed).toEqual([{ host: '127.0.0.1', port: 8443, servername: 'koala-probe.luno.koala.dev', rejectUnauthorized: false }]);
  });

  it('serves no certificate when Caddy cannot be reached', async () => {
    const { caddyfile, log, dir } = folder();
    const rig = dialing(new Error('connect ECONNREFUSED'));
    expect(await socketCaddy(join(dir, 'admin.sock'), caddyfile, log, '127.0.0.1:8443', rig.transport).certificateFor('koala-probe.luno.koala.dev')).toBeUndefined();
  });
});
