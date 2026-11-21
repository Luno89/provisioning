import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import { drainThenStop, PROXIES_CATCH_UP_MS } from './drain.js';

interface Answer { status: number | string; connection?: string | undefined }

const ask = (port: number, agent: http.Agent | false = false, path = '/'): Promise<Answer> => new Promise((done) => {
  http.get({ host: '127.0.0.1', port, path, agent }, (answer) => {
    answer.resume();
    answer.on('end', () => done({ status: answer.statusCode ?? 0, connection: answer.headers.connection }));
  }).on('error', (err: NodeJS.ErrnoException) => done({ status: err.code ?? err.message }));
});

describe('a backend told to stop in its pod', () => {
  it("serves as before while a service routes to it and while every node's proxy catches up, then closes once no connection is left", async () => {
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
    const lines: string[] = [];
    let stopped = false;
    let caughtUp: () => void = () => undefined;
    const waited: number[] = [];
    const wait = vi.fn((ms: number) => { waited.push(ms); return new Promise<void>((done) => { caughtUp = done; }); });
    const draining = drainThenStop({ place: { ip: '10.42.0.9', namespace: 'nowrinkles' }, slices, server, log: (line) => lines.push(line), wait }).then(() => { stopped = true; });

    await vi.waitFor(() => expect(wait).toHaveBeenCalled(), { timeout: 10_000 });
    expect(waited).toEqual([PROXIES_CATCH_UP_MS]);
    expect(await ask(port, kept)).toEqual({ status: 200, connection: 'keep-alive' });
    expect((await ask(port)).status).toBe(200);
    caughtUp();

    await vi.waitFor(() => expect(lines).toContain('[drain] answering what still comes with Connection: close, until no connection is left'), { timeout: 10_000 });
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
      "[drain] no service lists 10.42.0.9 as ready, so it serves 10 s more while every node's proxy catches up",
      '[drain] answering what still comes with Connection: close, until no connection is left',
      '[drain] no connection is left',
    ]);
  });

  it('outside a pod goes straight to closing once no connection is left, and in one whose endpoints could not be read at first reads them again', async () => {
    for (const place of [undefined, { ip: '10.42.0.9', namespace: 'nowrinkles' }]) {
      let refused = 0;
      const server = http.createServer((_request, answer) => answer.end('ok'));
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const lines: string[] = [];
      const wait = vi.fn(async () => undefined);
      const slices = async () => { if (refused++ === 0) throw new Error('forbidden'); return { items: [] }; };
      await drainThenStop({ place, slices, server, log: (line) => lines.push(line), wait, readAgain: reopening(50) });
      expect(server.listening).toBe(false);
      expect(wait).toHaveBeenCalledTimes(place ? 1 : 0);
      expect(refused).toBe(place ? 2 : 0);
      if (place) expect(lines).toContain('[drain] the endpoints could not be read (forbidden), so it keeps serving and reads them again');
    }
  });
});
