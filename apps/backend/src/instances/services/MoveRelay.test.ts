import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MoveRelay } from './MoveRelay.js';
import { MOVE_TOKEN_HEADER } from '../lib/identity-token.js';

const servers: http.Server[] = [];

async function poolApi(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ relay: MoveRelay; seen: Array<{ method?: string; path?: string; token?: string }> }> {
  const seen: Array<{ method?: string; path?: string; token?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, token: req.headers[MOVE_TOKEN_HEADER] as string | undefined });
    answer(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const kubeconfig = `apiVersion: v1\nclusters:\n- name: pool\n  cluster:\n    server: http://127.0.0.1:${port}\ncontexts:\n- name: pool\n  context: { cluster: pool, user: root }\ncurrent-context: pool\nusers:\n- name: root\n  user: { token: api-token }\n`;
  const relay = new MoveRelay({ kubeconfig: async () => kubeconfig, sign: (instanceId, part) => `signed-${instanceId}-${part}`, request: http.request as never });
  return { relay, seen };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

describe('telling a pool instance its move stopped', () => {
  it('posts the thaw to its backend through the pool node\'s API with a token for that instance and step', async () => {
    const { relay, seen } = await poolApi((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"thawed":true}'); });
    expect(await relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBeUndefined();
    expect(seen).toEqual([{ method: 'POST', path: '/api/v1/namespaces/pool-luno/services/http:instance-x-nowrinkles-x-luno:80/proxy/api/move/thaw', token: 'signed-inst-1-thaw' }]);
  });

  it('says why when the instance refuses, rather than counting any answer as thawed', async () => {
    const { relay } = await poolApi((_req, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"work is still running"}'); });
    expect(await relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBe('Koala\'s servers answered 409: work is still running');
  });

  it('says why when the pool node cannot be reached', async () => {
    const { relay } = await poolApi(() => undefined);
    for (const server of servers.splice(0)) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    expect(await relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toMatch(/^Koala's servers could not be reached: /);
  });
});
