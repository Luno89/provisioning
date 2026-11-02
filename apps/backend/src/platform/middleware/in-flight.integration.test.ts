import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IN_FLIGHT, InFlightLimits } from '../lib/in-flight-limits.js';
import { inFlightLimit } from './in-flight.js';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); }))); });

async function serve(limits: InFlightLimits) {
  const waiting: (() => void)[] = [];
  const app = express();
  app.set('trust proxy', true);
  app.use(inFlightLimit(limits));
  app.get('/held', (_req, res) => { waiting.push(() => res.json({ ok: true })); });
  app.get('/now', (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((done) => server.once('listening', done));
  const port = (server.address() as AddressInfo).port;
  const ask = (path: string, from?: string) => {
    const request = http.get({ host: '127.0.0.1', port, path, agent: false, headers: from ? { 'X-Forwarded-For': from } : {} });
    const answer = new Promise<number>((resolve, reject) => {
      request.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      request.on('error', reject);
    });
    return { request, answer };
  };
  return { ask, waiting, release: () => waiting.splice(0).forEach((answer) => answer()) };
}

describe('the cap on one address\'s open requests, on a real server', () => {
  it('refuses an address past its cap while others and the host itself go on, and takes it again once its requests finish or are dropped', async () => {
    const limits = new InFlightLimits({ ...IN_FLIGHT, initial: 3 });
    const { ask, waiting, release } = await serve(limits);
    const held = [ask('/held', '8.8.8.8'), ask('/held', '8.8.8.8'), ask('/held', '8.8.8.8')];
    await vi.waitFor(() => expect(waiting).toHaveLength(3));
    expect(await ask('/now', '8.8.8.8').answer).toBe(429);
    expect(await ask('/now', '8.8.4.4').answer).toBe(200);
    const fromHere = [ask('/held'), ask('/held'), ask('/held'), ask('/held')];
    await vi.waitFor(() => expect(waiting).toHaveLength(7));
    expect(limits.inFlight('8.8.8.8')).toBe(3);
    held[0]!.request.destroy();
    await held[0]!.answer.catch(() => undefined);
    await vi.waitFor(() => expect(limits.inFlight('8.8.8.8')).toBe(2));
    release();
    expect(await Promise.all([...held.slice(1), ...fromHere].map((one) => one.answer))).toEqual([200, 200, 200, 200, 200, 200]);
    await vi.waitFor(() => expect(limits.inFlight('8.8.8.8')).toBe(0));
    expect(await ask('/now', '8.8.8.8').answer).toBe(200);
  });

  it('learns how fast the server answers from each response it lets through', async () => {
    const limits = new InFlightLimits();
    const { ask } = await serve(limits);
    for (let at = 0; at < 40; at += 1) expect(await ask('/now', '8.8.8.8').answer).toBe(200);
    expect(limits.cap).toBeGreaterThan(IN_FLIGHT.initial);
  });
});
