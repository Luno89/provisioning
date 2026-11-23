import net from 'node:net';
import { expect, it } from 'vitest';

it('connects to a server it started itself', async () => {
  const server = net.createServer((socket) => socket.end('hello'));
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const heard = await new Promise<string>((done, failed) => {
    const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
    socket.on('data', (chunk) => done(chunk.toString()));
    socket.on('error', failed);
  });
  server.close();
  expect(heard).toBe('hello');
});
