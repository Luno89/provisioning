import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import os from 'os';
import type { AddressInfo } from 'net';
import { createServer, type ViteDevServer } from 'vite';
import { reopening } from '@koala/engine-core/reopening';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import { openRoutesOf } from '../../open-routes.js';
import { generateIdentityKey, identityKeysFrom, type IdentityKeyPair } from '../lib/identity-token.js';
import { InstanceReach } from './InstanceReach.js';
import { RootClient } from './RootClient.js';

const freshRootDb = await emptiedEachTime();

interface RootProcess { server: http.Server; provider: ReturnType<typeof rootAuthOver>['provider'] }

const servers: http.Server[] = [];
const proxies: ViteDevServer[] = [];

async function stop(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function startRoot(db: MongoDB, publicUrl: string, port: number): Promise<RootProcess> {
  const app = express();
  const server = http.createServer((req, res) => { app(req, res); });
  const world = rootAuthOver(db, { publicUrl, open: openRoutesOf('root'), instanceReach: new InstanceReach({ open: true }) });
  world.mount(app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.push(server);
  return { server, provider: world.provider };
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function webInFrontOf(rootPort: number): Promise<string> {
  const toRoot = { target: `http://127.0.0.1:${rootPort}`, changeOrigin: false, xfwd: true };
  const web = await createServer({ configFile: false, root: os.tmpdir(), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/oidc': toRoot } } });
  await web.listen();
  proxies.push(web);
  return `http://127.0.0.1:${(web.httpServer!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await stop(server);
  for (const web of proxies.splice(0)) await web.close();
});

const instanceOf = (rootUrl: string, keys: IdentityKeyPair, registrationCode: string, reach: typeof fetch): RootClient => new RootClient({
  kind: 'instance', clientId: 'inst-u1', rootUrl, publicUrl: 'http://127.0.0.1:1', owner: 'u1', keys, registrationCode, reach,
});

describe('an instance\'s client of root across root\'s restart behind its web server', () => {
  it('has a service token once root is back, for an instance that ran through the restart and for one that started while root was down behind its web server', async () => {
    const db = await freshRootDb();
    const rootPort = await freePort();
    const rootUrl = await webInFrontOf(rootPort);
    const first = await startRoot(db, rootUrl, rootPort);
    await db.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://127.0.0.1:1', createdAt: 'x', updatedAt: 'x', status: 'ready' });
    const keys = identityKeysFrom(generateIdentityKey());
    const code = await first.provider.registrationCode({ id: 'inst-u1', ownerId: 'u1' });
    const answers: Array<{ status: number; body: string }> = [];
    const reach: typeof fetch = async (url, init) => {
      const answer = await fetch(url, init);
      if (!answer.ok) answers.push({ status: answer.status, body: (await answer.clone().text()).slice(0, 300) });
      return answer;
    };
    const running = instanceOf(rootUrl, keys, code, reach);
    await running.register();
    answers.length = 0;

    await stop(first.server);
    const restarted = instanceOf(rootUrl, keys, code, reach);
    const tried = new Promise<string>((resolve) => { restarted.keepRegistering(resolve, reopening(10)); });
    const refused = restarted.registered.then(() => 'registered', (err: Error) => `refused for good: ${err.message}`);
    expect(await Promise.race([tried, refused])).toMatch(/^root has not registered this instance yet: it answered 502/);
    expect(answers[0]).toEqual({ status: 502, body: '' });

    const second = await startRoot(db, rootUrl, rootPort);
    expect(await second.provider.serviceCaller(await restarted.serviceToken())).toMatchObject({ clientId: 'inst-u1', kind: 'instance' });
    expect(await second.provider.serviceCaller(await running.freshToken())).toMatchObject({ clientId: 'inst-u1', kind: 'instance' });
  });
});
