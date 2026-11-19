import { describe, it, expect, afterEach } from 'vitest';
import type http from 'node:http';
import { networkInterfaces } from 'node:os';
import { serveHealth } from './worker-health.js';

let server: http.Server | undefined;
afterEach(() => { server?.close(); });

describe('a worker\'s health check', () => {
  it('answers ready only while the worker is running, so a rolling update waits for it', async () => {
    let running = false;
    server = serveHealth(0, '127.0.0.1', () => running);
    await new Promise((resolve) => server!.once('listening', resolve));
    const { port } = server.address() as { port: number };

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    running = true;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/anything-else`)).status).toBe(404);
  });

  it('answers only where it was told to listen, so the machine\'s network address refuses it', async () => {
    const outward = Object.values(networkInterfaces()).flat().find((address) => address && address.family === 'IPv4' && !address.internal);
    expect(outward, 'this computer has a network address besides loopback').toBeDefined();
    server = serveHealth(0, '127.0.0.1', () => true);
    await new Promise((resolve) => server!.once('listening', resolve));
    const { port } = server.address() as { port: number };
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const refused = await fetch(`http://${outward!.address}:${port}/healthz`).then(() => 'answered', (err: Error & { cause?: { code?: string } }) => err.cause?.code);
    expect(refused).toBe('ECONNREFUSED');
  });
});
