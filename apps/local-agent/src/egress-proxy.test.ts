import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import http from 'http';
import { EgressProxy } from './egress-proxy.js';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function connectSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
  });
}

function sendConnect(socket: net.Socket, targetHostPort: string): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      resolve(data);
    });
    socket.write(`CONNECT ${targetHostPort} HTTP/1.1\r\nHost: ${targetHostPort}\r\n\r\n`);
  });
}

describe('EgressProxy', () => {
  let proxy: EgressProxy;
  let proxyPort: number;
  let upstreamCalls: { port: number; host: string }[];
  let fakeUpstreamPort: number;
  let fakeUpstreamServer: net.Server;

  beforeEach(async () => {
    // A fake upstream: connect back to a local echo-less throwaway listener so pipe() has
    // something real underneath, without touching the real network.
    fakeUpstreamServer = net.createServer((sock) => sock.end());
    fakeUpstreamPort = await new Promise((resolve) => {
      fakeUpstreamServer.listen(0, '127.0.0.1', () => resolve((fakeUpstreamServer.address() as net.AddressInfo).port));
    });

    upstreamCalls = [];
    proxy = new EgressProxy((port, host, onConnect) => {
      upstreamCalls.push({ port, host });
      return net.connect(fakeUpstreamPort, '127.0.0.1', onConnect);
    });
    proxyPort = await freePort();
    await proxy.listen(proxyPort, await freePort());
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise((resolve) => fakeUpstreamServer.close(resolve));
  });

  it('refuses a CONNECT from a source IP with no allowlist at all', async () => {
    const client = await connectSocket(proxyPort);
    const response = await sendConnect(client, 'registry.npmjs.org:443');
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(upstreamCalls).toHaveLength(0);
    client.end();
  });

  it('refuses a host not on the allowlist', async () => {
    proxy.setAllowlist('127.0.0.1', [{ host: 'registry.npmjs.org' }]);
    const client = await connectSocket(proxyPort);
    const response = await sendConnect(client, 'evil.example:443');
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(response).toContain('evil.example');
    client.end();
  });

  it('allows a host on the allowlist and actually opens the upstream connection', async () => {
    proxy.setAllowlist('127.0.0.1', [{ host: 'registry.npmjs.org' }]);
    const client = await connectSocket(proxyPort);
    const response = await sendConnect(client, 'registry.npmjs.org:443');
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(upstreamCalls).toEqual([{ port: 443, host: 'registry.npmjs.org' }]);
    client.end();
  });

  it('enforces the port when one is named on the rule', async () => {
    proxy.setAllowlist('127.0.0.1', [{ host: 'registry.npmjs.org', ports: [443] }]);
    const client = await connectSocket(proxyPort);
    const response = await sendConnect(client, 'registry.npmjs.org:8080');
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    client.end();
  });

  it('clearAllowlist revokes access immediately', async () => {
    proxy.setAllowlist('127.0.0.1', [{ host: 'registry.npmjs.org' }]);
    proxy.clearAllowlist('127.0.0.1');
    const client = await connectSocket(proxyPort);
    const response = await sendConnect(client, 'registry.npmjs.org:443');
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    client.end();
  });
});

describe('EgressProxy control API', () => {
  let proxy: EgressProxy;
  let controlPort: number;

  beforeEach(async () => {
    proxy = new EgressProxy();
    controlPort = await freePort();
    await proxy.listen(await freePort(), controlPort);
  });

  afterEach(async () => { await proxy.close(); });

  function request(method: string, path: string, body?: unknown): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: controlPort, path, method, headers: { 'content-type': 'application/json' } },
        (res) => { res.on('data', () => undefined); res.on('end', () => resolve(res.statusCode ?? 0)); },
      );
      req.on('error', reject);
      if (body !== undefined) req.end(JSON.stringify(body));
      else req.end();
    });
  }

  it('POST /allowlist sets an allowlist a subsequent CONNECT can use', async () => {
    const status = await request('POST', '/allowlist', { containerIp: '10.0.0.5', rules: [{ host: 'x.com' }] });
    expect(status).toBe(200);
  });

  it('DELETE /allowlist/:ip clears it', async () => {
    await request('POST', '/allowlist', { containerIp: '10.0.0.5', rules: [{ host: 'x.com' }] });
    const status = await request('DELETE', '/allowlist/10.0.0.5');
    expect(status).toBe(200);
  });

  it('404s an unknown route', async () => {
    expect(await request('GET', '/nonsense')).toBe(404);
  });
});
