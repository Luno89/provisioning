import net from 'node:net';
import http from 'node:http';
import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECT_MS, connectLimitedAgents, dependencyDispatcher } from './http.js';

const servers: net.Server[] = [];
const held: net.Socket[] = [];

afterEach(async () => {
  held.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

function silent(): Promise<number> {
  return listen(net.createServer((socket) => { held.push(socket); }));
}

function slowAnswer(ms: number): Promise<number> {
  const server = http.createServer((_req, res) => { setTimeout(() => res.end('done'), ms); });
  server.on('connection', (socket) => held.push(socket));
  return listen(server);
}

describe('the connect limit', () => {
  it('is ten seconds', () => {
    expect(CONNECT_MS).toBe(10_000);
  });

  it('ends a fetch whose server takes the connection and never finishes the secure handshake, as a connect timeout', async () => {
    const port = await silent();
    const started = Date.now();
    const failed = await fetch(`https://127.0.0.1:${port}/`, { dispatcher: dependencyDispatcher({ connectMs: 300 }) } as unknown as RequestInit).catch((err: unknown) => err);
    expect((failed as { cause?: { code?: string } }).cause?.code).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never limits how long the answer takes', async () => {
    const port = await slowAnswer(800);
    const answer = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: dependencyDispatcher({ connectMs: 300 }) } as unknown as RequestInit);
    expect(await answer.text()).toBe('done');
  });

  it('ends an axios call whose server never finishes the secure handshake, as ETIMEDOUT', async () => {
    const port = await silent();
    const agents = connectLimitedAgents(300);
    const failed = await axios.get(`https://127.0.0.1:${port}/`, { ...agents, proxy: false }).catch((err: unknown) => err);
    expect((failed as { code?: string }).code).toBe('ETIMEDOUT');
  });

  it('never limits how long an axios answer takes', async () => {
    const port = await slowAnswer(800);
    const agents = connectLimitedAgents(300);
    const answer = await axios.get<string>(`http://127.0.0.1:${port}/`, { ...agents, proxy: false });
    expect(answer.data).toBe('done');
  });
});
