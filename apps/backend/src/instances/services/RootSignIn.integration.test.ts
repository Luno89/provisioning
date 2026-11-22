import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { InstanceReach } from './InstanceReach.js';
import { instancesRouter } from '../routes/instances.js';
import { rootTokenOf } from '../wiring/sign-in.js';
import { InstanceWatchSetting } from './InstanceWatchSetting.js';
import { InstanceUpdates } from './InstanceUpdates.js';
import { machinesThroughRoot, rootSignInWorld, runBearersThroughRoot, runTokensThroughRoot, signingInThroughRoot, sessionsThroughRoot, logoutKeptFromAPrivateAddress, type Served } from '../testing/root-sign-in-behaviour.js';

const freshInstanceDb = await emptiedEachTime();
const freshRootDb = await emptiedEachTime();

interface Listening extends Served { server: http.Server }

async function serve(): Promise<Listening> {
  const app = express();
  const server = http.createServer((req, res) => { app(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, app };
}

const world = rootSignInWorld<Listening>({
  databases: { root: freshRootDb, instance: freshInstanceDb },
  serve: () => serve(),
  reach: () => new InstanceReach({ open: true }),
  alias: (root) => root.url.replace('127.0.0.1', 'localhost'),
  revokedAt: () => new Date().toISOString(),
  goDown: async (served) => { await new Promise((resolve) => served.server.close(resolve)); },
  comeBack: async (served) => { await new Promise<void>((resolve) => served.server.listen(Number(new URL(served.url).port), '127.0.0.1', resolve)); },
});

afterEach(async () => {
  await new Promise((resolve) => world.root.server.close(resolve));
  await new Promise((resolve) => world.instance.server.close(resolve));
});

describe('signing in on an instance through root\'s OpenID provider', () => {
  signingInThroughRoot(world);
  runTokensThroughRoot(world);
  runBearersThroughRoot(world);

  it('in production never sends a logout to an address the instance made up on this machine or a private network', async () => {
    await logoutKeptFromAPrivateAddress(world, new InstanceReach({ open: false, domain: 'koala.dev' }));
  });

  sessionsThroughRoot(world);
});

describe('machines as clients of root', () => {
  machinesThroughRoot(world);
});

describe('what an instance asks root for with what root signed', () => {

  it('lets the instance\'s own clients ask root about its watch and its updates with its service token', async () => {
    world.root.app.use('/api/instances', express.json(), instancesRouter({ instances: world.rootService, chart: async () => '' }));
    world.signIn.keepRegistering(() => undefined);
    const asInstance = { rootUrl: world.root.url, instanceId: 'inst-u1', token: rootTokenOf(world.signIn)! };
    expect(await new InstanceWatchSetting(asInstance).read()).toMatchObject({ notifyWhenUnreachable: true });
    expect(await new InstanceWatchSetting(asInstance).set(false)).toMatchObject({ notifyWhenUnreachable: false });
    const updates = new InstanceUpdates(asInstance, async () => { throw new Error('this instance was installed without a check-in, so nothing reads its jobs'); });
    expect(await updates.view()).toMatchObject({ auto: true });
    expect(await updates.findings()).toEqual({ findings: [] });
    await expect(new InstanceWatchSetting({ ...asInstance, instanceId: 'inst-other' }).read()).rejects.toMatchObject({ status: 401 });
  });

});
