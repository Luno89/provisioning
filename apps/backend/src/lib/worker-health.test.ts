import { describe, it, expect, afterEach } from 'vitest';
import type http from 'node:http';
import { healthPort, serveHealth } from './worker-health.js';

let server: http.Server | undefined;
afterEach(() => { server?.close(); });

describe('a worker\'s health check', () => {
  it('answers ready only while the worker is running, so a rolling update waits for it', async () => {
    let running = false;
    server = serveHealth(0, () => running);
    await new Promise((resolve) => server!.once('listening', resolve));
    const { port } = server.address() as { port: number };

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    running = true;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/anything-else`)).status).toBe(404);
  });

  it('is off unless a port is given', () => {
    expect(healthPort({})).toBeUndefined();
    expect(healthPort({ HEALTH_PORT: 'nope' })).toBeUndefined();
    expect(healthPort({ HEALTH_PORT: '8090' })).toBe(8090);
  });
});
