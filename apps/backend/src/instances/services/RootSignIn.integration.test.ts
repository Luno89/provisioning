import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { InstanceReach } from './InstanceReach.js';
import { hashCredential } from './InstanceService.js';
import { instancesRouter } from '../routes/instances.js';
import { rootTokenOf } from '../wiring/sign-in.js';
import { InstanceWatchSetting } from './InstanceWatchSetting.js';
import { InstanceTrial } from './InstanceTrial.js';
import { InstanceUpdates } from './InstanceUpdates.js';
import { hubLinkRouter } from '../../hub/routes/hub-link.js';
import { ProjectInviteService } from '../../hub/services/ProjectInviteService.js';
import { HubRootClient } from '../../hub/services/HubRootClient.js';
import { principalOf } from '../../platform/lib/permissions.js';
import { rootSignInWorld, signingInThroughRoot, sessionsThroughRoot, logoutKeptFromAPrivateAddress, matching, having, type Served } from '../testing/root-sign-in-behaviour.js';

const freshHubDb = await emptiedEachTime();
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
  databases: { root: freshRootDb, instance: freshInstanceDb, hub: freshHubDb },
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
  await new Promise((resolve) => world.hub.server.close(resolve));
});

describe('signing in on an instance through root\'s OpenID provider', () => {
  signingInThroughRoot(world);

  it('in production never sends a logout to an address the instance made up on this machine or a private network', async () => {
    await logoutKeptFromAPrivateAddress(world, new InstanceReach({ open: false, domain: 'koala.dev' }));
  });

  sessionsThroughRoot(world);
});

describe('what an instance and the hub ask root for with what root signed', () => {
  it('renews through root the token the instance holds for its owner once it is about to run out', async () => {
    await world.signIn.announce();
    world.offset = -21 * 60 * 1000;
    const atInstance = world.signIn.verified((await world.signInAs('u1')).instanceJar.get('session'));
    const held = await world.signIn.personToken(atInstance);
    world.offset = 0;
    const renewed = await world.signIn.personToken(atInstance);
    expect(held).toBeTruthy();
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(held);
    expect(Date.parse((await world.instanceDb.instances.getClientSession(atInstance!.sid))!.accessExpiresAt!)).toBeGreaterThan(Date.now() + 60_000);
  });

  it('lets the instance\'s own clients ask root about its watch, its move and its updates with its service token', async () => {
    world.root.app.use('/api/instances', express.json(), instancesRouter({ instances: world.rootService, chart: async () => '' }));
    world.signIn.keepAnnouncing(() => undefined);
    const asInstance = { rootUrl: world.root.url, instanceId: 'inst-u1', token: rootTokenOf(world.signIn)! };
    expect(await new InstanceWatchSetting(asInstance).read()).toMatchObject({ notifyWhenUnreachable: true });
    expect(await new InstanceWatchSetting(asInstance).set(false)).toMatchObject({ notifyWhenUnreachable: false });
    expect(await new InstanceTrial(asInstance).moveState()).toBeNull();
    const updates = new InstanceUpdates(asInstance, async () => { throw new Error('this instance was installed without a check-in, so nothing reads its jobs'); });
    expect(await updates.view()).toMatchObject({ auto: true });
    expect(await updates.findings()).toEqual({ findings: [] });
    await expect(new InstanceWatchSetting({ ...asInstance, instanceId: 'inst-other' }).read()).rejects.toMatchObject({ status: 401 });
  });

  it('sends an invite the hub asks for with its own service token, from the person it signed in, and takes none an instance asks for', async () => {
    world.root.app.put('/api/hub-link/sign-in-key', (_req, res) => { res.json({ since: 'x' }); });
    world.root.app.use('/api/hub-link', express.json(), hubLinkRouter({
      invites: new ProjectInviteService({ invites: world.rootDb.accounts, people: world.rootDb.accounts, principalFor: (user) => principalOf(user, { role: 'root' }), limits: () => world.rootDb.accounts.getInviteLimits(), rootUrl: world.root.url }),
      hash: hashCredential,
      provider: world.provider,
      people: world.rootDb.accounts,
    }));
    const onHub = world.hubSignIn.verified((await world.signInAs('u2', world.hub)).instanceJar.get('session'));
    const ask = (token: () => Promise<string>) => new HubRootClient({ rootUrl: world.root.url, token }).send(
      { email: 'cy@example.com', projectName: 'Shop', role: 'client', join: 'J'.repeat(32), inviterId: 'u2', inviterEmail: 'u2@example.com' },
      { id: 'u2', email: 'u2@example.com', vouch: () => world.hubSignIn.personToken(onHub) },
    );
    world.hubSignIn.keepAnnouncing(() => undefined);
    const sent = await ask(() => world.hubSignIn.serviceToken());
    expect(sent).toMatchObject({ link: matching(new RegExp(`^${world.root.url}/#/join\\?code=`)), emailed: false });
    expect(await world.rootDb.accounts.getInvites()).toEqual([having({ email: 'cy@example.com', createdBy: 'u2', project: having({ name: 'Shop', role: 'client' }) })]);
    world.signIn.keepAnnouncing(() => undefined);
    await expect(ask(() => world.signIn.serviceToken())).rejects.toThrow('root would not send the invite (401)');
    expect(await world.rootDb.accounts.getInvites()).toHaveLength(1);
  });
});
