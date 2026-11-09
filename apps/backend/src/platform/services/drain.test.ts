import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { drainThenStop, PROXIES_CATCH_UP_MS } from './drain.js';

const POD = { ip: '10.42.0.9', namespace: 'nowrinkles' };

const routedTo = (ready: boolean) => ({ items: [{ endpoints: [{ addresses: [POD.ip], conditions: { ready } }] }] });

function serverWith(connectionCounts: number[], listening = true) {
  const server = mock<Server>();
  (server as { listening: boolean }).listening = listening;
  server.getConnections.mockImplementation(((done: (err: Error | null, count: number) => void) => {
    done(null, connectionCounts.shift() ?? 0);
    return server;
  }) as never);
  server.close.mockImplementation(((done?: () => void) => {
    (server as { listening: boolean }).listening = false;
    done?.();
    return server;
  }) as never);
  return server;
}

describe('a backend told to stop in its pod', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves while a service routes to it and while every node's proxy catches up, then asks every client to reconnect and exits once no connection is left", async () => {
    const server = serverWith([2, 1, 0]);
    const sockets = { disconnectSockets: vi.fn() };
    const lines: string[] = [];
    let routed = 2;
    const slices = vi.fn(async () => { routed -= 1; return routedTo(routed >= 0); });
    let caughtUp: () => void = () => undefined;
    const waited: number[] = [];
    const wait = vi.fn((ms: number) => { waited.push(ms); return new Promise<void>((done) => { caughtUp = done; }); });
    let stopped = false;

    const draining = drainThenStop({ place: POD, slices, server, sockets, log: (line) => lines.push(line), wait }).then(() => { stopped = true; });

    await vi.advanceTimersByTimeAsync(1000);
    expect(slices).toHaveBeenCalledTimes(3);
    expect(slices).toHaveBeenCalledWith('nowrinkles');
    expect(waited).toEqual([PROXIES_CATCH_UP_MS]);
    expect(sockets.disconnectSockets).not.toHaveBeenCalled();
    expect(server.prependListener).not.toHaveBeenCalled();

    caughtUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.disconnectSockets).toHaveBeenCalledWith(true);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await draining;
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      '[drain] still serving until no service sends new connections to 10.42.0.9',
      "[drain] no service lists 10.42.0.9 as ready, so it serves 10 s more while every node's proxy catches up",
      '[drain] answering what still comes with Connection: close, until no connection is left',
      '[drain] no connection is left',
    ]);
  });

  it('answers what still comes with Connection: close', async () => {
    const server = serverWith([0]);
    await drainThenStop({ place: undefined, server, sockets: { disconnectSockets: vi.fn() }, log: vi.fn() });
    const [event, listener] = server.prependListener.mock.calls[0] ?? [];
    expect(event).toBe('request');
    const answer = { setHeader: vi.fn() };
    (listener as (request: unknown, answer: unknown) => void)({}, answer);
    expect(answer.setHeader).toHaveBeenCalledWith('Connection', 'close');
  });

  it('outside a pod goes straight to asking clients to reconnect', async () => {
    const server = serverWith([0]);
    const sockets = { disconnectSockets: vi.fn() };
    const slices = vi.fn();
    const wait = vi.fn(async () => undefined);
    await drainThenStop({ place: undefined, slices, server, sockets, log: vi.fn(), wait });
    expect(slices).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(sockets.disconnectSockets).toHaveBeenCalledWith(true);
    expect(server.close).toHaveBeenCalled();
  });

  it('in a pod whose endpoints cannot be read keeps serving and reads them again, 5 s doubling, until they say nothing routes to it', async () => {
    const server = serverWith([0]);
    const lines: string[] = [];
    const wait = vi.fn(async () => undefined);
    const answers: Array<() => unknown> = [() => { throw new Error('forbidden'); }, () => { throw new Error('forbidden'); }, () => routedTo(false)];
    const slices = vi.fn(async () => answers.shift()!());
    const drained = drainThenStop({ place: POD, slices: slices as never, server, sockets: { disconnectSockets: vi.fn() }, log: (line) => lines.push(line), wait });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(slices).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + 10_000);
    await drained;
    expect(slices).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.includes('could not be read'))).toEqual(['[drain] the endpoints could not be read (forbidden), so it keeps serving and reads them again']);
  });

  it('does not close a server that already stopped listening, and counts an unreadable connection total as none left', async () => {
    const server = mock<Server>();
    (server as { listening: boolean }).listening = false;
    server.getConnections.mockImplementation(((done: (err: Error | null, count: number) => void) => {
      done(new Error('gone'), 5);
      return server;
    }) as never);
    await drainThenStop({ place: undefined, server, sockets: { disconnectSockets: vi.fn() }, log: vi.fn() });
    expect(server.close).not.toHaveBeenCalled();
  });
});
