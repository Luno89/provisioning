import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { Fence } from '../lib/fence.js';
import { testDatabase } from '../lib/test-database.js';
import { FenceWatch } from '../services/FenceWatch.js';
import { stopBackend } from './shutdown.js';

describe('the backend stopping cleanly in a pod', () => {
  it('drains its server, takes itself off the live list and exits', async () => {
    const db = await testDatabase();
    const watch = new FenceWatch({ store: db.platform, fence: new Fence(), process: { id: 'backend-stopping', name: 'backend' } });
    await watch.start();
    const server = http.createServer((_request, answer) => answer.end('ok'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const exits: number[] = [];
    await stopBackend({
      stopping: () => undefined,
      drain: { place: { ip: '10.42.0.9', namespace: 'nowrinkles' }, slices: async () => ({ items: [] }), server, sockets: { disconnectSockets: () => undefined }, log: () => undefined, wait: vi.fn(async () => undefined) },
      fences: watch,
      exit: (code) => { exits.push(code); },
    });
    expect(server.listening).toBe(false);
    expect(await db.platform.processesSeenSince(new Date(Date.now() - 60_000).toISOString())).toEqual([]);
    expect(exits).toEqual([0]);
  });
});
