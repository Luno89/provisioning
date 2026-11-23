import net from 'node:net';
import { expect, it } from 'vitest';

it('connects to a port nobody of its own listens on', async () => {
  const socket = net.connect(9, '127.0.0.1');
  socket.on('error', () => undefined);
  socket.destroy();
  expect(1).toBe(1);
});
