import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom } from '../instances/lib/identity-token.js';
import { identityRouter } from '../instances/routes/identity.js';
import { instancesRouter } from '../instances/routes/instances.js';
import { IdentityService } from '../instances/services/IdentityService.js';
import { InstanceService } from '../instances/services/InstanceService.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { harnessApp, TEST_USER } from '../platform/routes/test-harness.js';
import { untilKoalaReady } from './dev-machine.js';
import { koalaPlacedAndUp } from '../instances/testing/placed-koala.js';

interface Root {
  rootApi: string;
  report: (status: string, detail: string) => Promise<void>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
}

const running: http.Server[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await new Promise((done) => server.close(done));
});

function listen(app: Express, port: number): Promise<http.Server> {
  const server = http.createServer(app);
  running.push(server);
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

async function rootWithAJoinedKoala(): Promise<Root> {
  const db = await testDatabase();
  const mesh = { createPreAuthKey: async () => ({ key: 'mesh-key' }), listUserDevices: async () => [{ ipAddresses: ['100.64.0.9'] }] };
  const instances = new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev' }, mesh);
  const identity = new IdentityService({ role: 'root', signing: identityKeysFrom(generateIdentityKey()) }, db);
  const app = await harnessApp({
    prefix: '/api',
    router: () => Router()
      .use('/instances', instancesRouter({ instances, chart: async () => '', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() }))
      .use('/identity', identityRouter({ servesTenants: false, accounts: { identity, signedIn: async () => TEST_USER } })),
  }, db, () => TEST_USER);
  let server = await listen(app, 0);
  const { port } = server.address() as AddressInfo;
  const joined = { value: await koalaPlacedAndUp(instances, db, TEST_USER.id, { id: 'desk', name: 'desk', meshIp: '100.64.0.9' }, 'luno') };
  return {
    rootApi: `http://127.0.0.1:${port}`,
    report: async (status, detail) => {
      const reported = await instances.report(joined.value.instanceId, joined.value.credential, { status, detail });
      if (!reported.ok) throw new Error(reported.error);
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      running.splice(running.indexOf(server), 1);
    },
    start: async () => { server = await listen(app, port); },
  };
}

describe('dev waiting for root to say this computer\'s Koala is up', () => {
  it('tells each state root gives once, however often it asks, and ends when root says Koala is ready', async () => {
    const root = await rootWithAJoinedKoala();
    await root.report('installing', 'Installing the instance');
    const said: string[] = [];
    const next = ['installing', 'installing', 'ready'];
    const pause = async (): Promise<void> => {
      const status = next.shift();
      if (status === 'installing') await root.report(status, 'Installing the instance');
      if (status === 'ready') await root.report(status, 'Installed');
    };

    await untilKoalaReady('session=dev', { rootApi: root.rootApi, say: (line) => said.push(line), pause });

    expect(said).toEqual(['your Koala is installing: Installing the instance', 'your Koala is ready: Installed']);
  });

  it('waits through root restarting under its watcher, and goes on once root answers again', async () => {
    const root = await rootWithAJoinedKoala();
    await root.report('installing', 'Installing the instance');
    await root.stop();
    const said: string[] = [];
    let restarted = false;
    const pause = async (): Promise<void> => {
      if (restarted) return;
      restarted = true;
      await root.report('ready', 'Installed');
      await root.start();
    };

    await untilKoalaReady('session=dev', { rootApi: root.rootApi, say: (line) => said.push(line), pause });

    expect(said).toEqual(['root stopped answering (its watcher restarts it when its code changes); waiting for it', 'your Koala is ready: Installed']);
  });

  it('stops with root\'s reason when putting Koala on the computer failed', async () => {
    const root = await rootWithAJoinedKoala();
    await root.report('failed', 'k3s did not start: port 6443 is taken');
    const said: string[] = [];

    await expect(untilKoalaReady('session=dev', { rootApi: root.rootApi, say: (line) => said.push(line), pause: async () => undefined }))
      .rejects.toThrow('putting Koala on this computer failed: k3s did not start: port 6443 is taken');
    expect(said).toEqual(['your Koala is failed: k3s did not start: port 6443 is taken']);
  });
});
