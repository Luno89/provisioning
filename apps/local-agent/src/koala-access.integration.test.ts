import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { connectAgainIfRefused, koalaSocket, type KoalaAccess } from './koala-access.js';

describe('a machine whose Koala refused it while root could not give it a token', () => {
  it('stays refused until root is back, then connects again with a token root gives it', async () => {
    const http = createServer();
    const koala = new Server(http);
    const tokens: unknown[] = [];
    koala.of('/agent').use((socket, next) => {
      tokens.push(socket.handshake.auth.token);
      next(socket.handshake.auth.token ? undefined : new Error('Unauthorized: send a token root gave this machine for this Koala'));
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    let rootAnswers = false;
    const access: KoalaAccess = {
      token: async () => 'held',
      freshToken: async () => { if (!rootAnswers) throw new Error('unexpected HTTP response status code'); return 'fresh'; },
      renewsAt: () => undefined,
    };
    const said: string[] = [];
    const socket = koalaSocket({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, resource: 'koala', access, auth: {}, say: (line) => said.push(line) });
    try {
      await new Promise<void>((refused) => socket.once('connect_error', () => refused()));
      expect(socket.active).toBe(false);
      expect(connectAgainIfRefused(socket)).toBe(true);
      await new Promise<void>((refused) => socket.once('connect_error', () => refused()));

      rootAnswers = true;
      const connected = new Promise<void>((done) => socket.once('connect', () => done()));
      expect(connectAgainIfRefused(socket)).toBe(true);
      await connected;
      expect(tokens).toEqual([undefined, undefined, 'fresh']);
      expect(connectAgainIfRefused(socket)).toBe(false);
      expect(said.filter((line) => line.startsWith('this machine could not take a token for its Koala from root'))).toHaveLength(2);
    } finally {
      socket.close();
      await koala.close();
    }
  });
});
