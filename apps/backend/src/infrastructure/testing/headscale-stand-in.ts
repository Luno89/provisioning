import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HeadscaleStandIn {
  url: string;
  apiKey: string;
  asked: string[];
  unhandled: string[];
  close(): Promise<void>;
}

export async function startHeadscaleStandIn(): Promise<HeadscaleStandIn> {
  const apiKey = crypto.randomBytes(24).toString('hex');
  const users: { id: string; name: string }[] = [];
  const nodes: { id: string; user: string }[] = [];
  const asked: string[] = [];
  const unhandled: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://headscale.test');
    const answer = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) { answer(401, { message: 'Unauthorized' }); return; }
    asked.push(`${req.method} ${url.pathname}${url.search}`);
    const [, api, version, kind, id] = url.pathname.split('/');
    if (api !== 'api' || version !== 'v1') { unhandled.push(`${req.method} ${url.pathname}`); answer(404); return; }
    if (req.method === 'GET' && kind === 'apikey') { answer(200, { apiKeys: [] }); return; }
    if (req.method === 'GET' && kind === 'user' && !id) { answer(200, { users: users.filter((user) => !url.searchParams.get('name') || user.name === url.searchParams.get('name')) }); return; }
    if (req.method === 'GET' && kind === 'node' && !id) { answer(200, { nodes: nodes.filter((node) => !url.searchParams.get('user') || node.user === url.searchParams.get('user')) }); return; }
    if (req.method === 'DELETE' && kind === 'node' && id) {
      const at = nodes.findIndex((node) => node.id === id);
      if (at < 0) { answer(404, { message: 'node not found' }); return; }
      nodes.splice(at, 1);
      answer(200, {});
      return;
    }
    if (req.method === 'DELETE' && kind === 'user' && id) {
      const at = users.findIndex((user) => user.id === id);
      if (at < 0) { answer(404, { message: 'user not found' }); return; }
      users.splice(at, 1);
      answer(200, {});
      return;
    }
    unhandled.push(`${req.method} ${url.pathname}`);
    answer(404, { message: `the Headscale stand-in has no ${req.method} ${url.pathname}` });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey,
    asked,
    unhandled,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
