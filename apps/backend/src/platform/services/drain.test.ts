import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { drainThenStop } from './drain.js';

const ask = (port: number): Promise<number | string> => new Promise((done) => {
  http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (answer) => { answer.resume(); answer.on('end', () => done(answer.statusCode ?? 0)); })
    .on('error', (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
});

describe('a backend told to stop in its pod', () => {
  it('serves new connections until no service routes to it, then takes none and lets what is in flight finish', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    const server = http.createServer((request, answer) => {
      if (request.url === '/slow') void held.then(() => answer.end('late'));
      else answer.end('ok');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const slow = new Promise<string>((done) => {
      http.get({ host: '127.0.0.1', port, path: '/slow', agent: false }, (answer) => { let body = ''; answer.on('data', (chunk) => { body += chunk; }); answer.on('end', () => done(body)); });
    });
    await new Promise((done) => setTimeout(done, 50));

    let routed = 3;
    const servedWhileRouted: (number | string)[] = [];
    const slices = vi.fn(async () => {
      if (routed > 0) servedWhileRouted.push(await ask(port));
      routed -= 1;
      return { items: [{ endpoints: [{ addresses: ['10.42.0.9'], conditions: { ready: routed >= 0 } }] }] };
    });
    const sockets = { close: vi.fn() };
    const lines: string[] = [];
    let stopped = false;
    const draining = drainThenStop({ place: { ip: '10.42.0.9', namespace: 'nowrinkles' }, slices, server, sockets, log: (line) => lines.push(line) }).then(() => { stopped = true; });

    await vi.waitFor(() => expect(sockets.close).toHaveBeenCalled(), { timeout: 10_000 });
    expect(servedWhileRouted).toEqual([200, 200, 200]);
    expect(slices).toHaveBeenCalledWith('nowrinkles');
    expect(await ask(port)).toBe('ECONNREFUSED');
    expect(stopped).toBe(false);

    release();
    expect(await slow).toBe('late');
    await draining;
    expect(lines).toEqual([
      '[drain] still serving until no service sends new connections to 10.42.0.9',
      '[drain] taking no new connections; finishing what is in flight',
      '[drain] everything in flight has finished',
    ]);
  }, 20_000);

  it('outside a pod, and when the endpoints cannot be read, stops taking connections at once', async () => {
    for (const place of [undefined, { ip: '10.42.0.9', namespace: 'nowrinkles' }]) {
      const server = http.createServer((_request, answer) => answer.end('ok'));
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const lines: string[] = [];
      await drainThenStop({ place, slices: async () => { throw new Error('forbidden'); }, server, sockets: { close: () => undefined }, log: (line) => lines.push(line) });
      expect(server.listening).toBe(false);
      if (place) expect(lines).toContain('[drain] the endpoints could not be read, so the backend stops now: forbidden');
    }
  });
});
