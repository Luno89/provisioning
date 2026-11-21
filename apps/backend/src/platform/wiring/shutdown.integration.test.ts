import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { stopBackend } from './shutdown.js';

describe('the backend stopping cleanly in a pod', () => {
  it('drains its server and exits', async () => {
    const server = http.createServer((_request, answer) => answer.end('ok'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const exits: number[] = [];
    await stopBackend({
      stopping: () => undefined,
      drain: { place: { ip: '10.42.0.9', namespace: 'nowrinkles' }, slices: async () => ({ items: [] }), server, sockets: { disconnectSockets: () => undefined }, log: () => undefined, wait: vi.fn(async () => undefined) },
      exit: (code) => { exits.push(code); },
    });
    expect(server.listening).toBe(false);
    expect(exits).toEqual([0]);
  });
});
