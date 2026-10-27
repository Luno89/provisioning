import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { drainThenStop } from './drain.js';

interface Answer { status: number | string; connection?: string | undefined }

const ask = (port: number, agent: http.Agent | false = false, path = '/'): Promise<Answer> => new Promise((done) => {
  http.get({ host: '127.0.0.1', port, path, agent }, (answer) => {
    answer.resume();
    answer.on('end', () => done({ status: answer.statusCode ?? 0, connection: answer.headers.connection }));
  }).on('error', (err: NodeJS.ErrnoException) => done({ status: err.code ?? err.message }));
});

describe('a backend told to stop in its pod', () => {
  it('serves as before while a service routes to it, then asks every client to reconnect and exits once no connection is left', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    const server = http.createServer((request, answer) => {
      if (request.url === '/slow') void held.then(() => answer.end('late'));
      else answer.end('ok');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const kept = new http.Agent({ keepAlive: true });
    expect(await ask(port, kept)).toEqual({ status: 200, connection: 'keep-alive' });
    const slow = ask(port, false, '/slow');
    await new Promise((done) => setTimeout(done, 50));

    let routed = 2;
    const whileRouted: Answer[] = [];
    const slices = vi.fn(async () => {
      if (routed > 0) whileRouted.push(await ask(port, kept));
      routed -= 1;
      return { items: [{ endpoints: [{ addresses: ['10.42.0.9'], conditions: { ready: routed >= 0 } }] }] };
    });
    const sockets = { disconnectSockets: vi.fn() };
    const lines: string[] = [];
    let stopped = false;
    const draining = drainThenStop({ place: { ip: '10.42.0.9', namespace: 'nowrinkles' }, slices, server, sockets, log: (line) => lines.push(line) }).then(() => { stopped = true; });

    await vi.waitFor(() => expect(sockets.disconnectSockets).toHaveBeenCalledWith(true), { timeout: 10_000 });
    expect(whileRouted).toEqual([{ status: 200, connection: 'keep-alive' }, { status: 200, connection: 'keep-alive' }]);
    expect(slices).toHaveBeenCalledWith('nowrinkles');
    expect(await ask(port, kept)).toEqual({ status: 200, connection: 'close' });
    expect(await ask(port)).toEqual({ status: 200, connection: 'close' });
    expect(stopped).toBe(false);

    release();
    expect((await slow).status).toBe(200);
    kept.destroy();
    await draining;
    expect(server.listening).toBe(false);
    expect(lines).toEqual([
      '[drain] still serving until no service sends new connections to 10.42.0.9',
      '[drain] answering what still comes with Connection: close, until no connection is left',
      '[drain] no connection is left',
    ]);
  }, 30_000);

  it('outside a pod, and when the endpoints cannot be read, goes straight to asking clients to reconnect', async () => {
    for (const place of [undefined, { ip: '10.42.0.9', namespace: 'nowrinkles' }]) {
      const server = http.createServer((_request, answer) => answer.end('ok'));
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const lines: string[] = [];
      await drainThenStop({ place, slices: async () => { throw new Error('forbidden'); }, server, sockets: { disconnectSockets: () => undefined }, log: (line) => lines.push(line) });
      expect(server.listening).toBe(false);
      if (place) expect(lines).toContain('[drain] the endpoints could not be read, so the backend drains now: forbidden');
    }
  });
});
