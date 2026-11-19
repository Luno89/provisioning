import http from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { joinThisComputer, untilKoalaReady } from './dev-machine.js';
import { koalaPlacedAndUp } from '../instances/testing/placed-koala.js';
import { MachineAccounts } from '../machines/services/MachineAccounts.js';
import { myMachinesRouter } from '../machines/routes/my-machines.js';
import { quietAccountSides } from '../machines/testing/wiring-world.js';
import { hashMachineCode } from '../machines/lib/machines.js';
import { DEV } from '../instances/index.js';

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

describe('dev joining this computer to root as a machine', () => {
  let place = '';
  let path0: string | undefined;
  afterEach(async () => {
    process.env.PATH = path0;
    await rm(place, { recursive: true, force: true });
  });

  async function rootGivingCommands(machineCommand: (out: string) => string) {
    place = await mkdtemp(path.join(tmpdir(), 'koala-dev-join-'));
    const bin = path.join(place, 'bin');
    await mkdir(bin);
    const out = path.join(place, 'ran');
    await writeFile(path.join(bin, 'curl'), `#!/bin/sh\ncat <<'SCRIPT'\n${machineCommand(out)}\nSCRIPT\n`);
    await chmod(path.join(bin, 'curl'), 0o755);
    path0 = process.env.PATH;
    process.env.PATH = `${bin}:${path0 ?? ''}`;
    const db = await testDatabase();
    const accounts = new MachineAccounts({ ...quietAccountSides(), store: db.machines, signing: identityKeysFrom(generateIdentityKey()) });
    const app = await harnessApp({ prefix: '/api', router: () => Router().use('/my-machines', myMachinesRouter({ accounts, koalaOf: async () => undefined })) }, db, () => TEST_USER);
    const server = await listen(app, 0);
    return { db, out, config: path.join(place, 'config'), folder: path.join(place, 'koala'), rootApi: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('writes this checkout\'s own Koala values, asks root for a machine command for your Koala, and runs it working in the folder dev names', async () => {
    const root = await rootGivingCommands((out) => `printf '%s\\n' "$@" > '${out}'`);
    const said: string[] = [];
    await joinThisComputer('session=dev', 'http://dev.localhost:5173', { rootApi: root.rootApi, config: root.config, folder: root.folder, say: (line) => said.push(line) });
    const [code, ...rest] = (await readFile(root.out, 'utf8')).trim().split('\n');
    expect(rest).toEqual(['--folder', root.folder]);
    expect(await root.db.machines.getMachineJoin(hashMachineCode(code!))).toMatchObject({ ownerId: TEST_USER.id, koalaName: DEV.instanceName });
    expect(await readFile(path.join(root.config, 'koala-values.yaml'), 'utf8')).toContain('publicUrl: "http://dev.localhost:5173"');
    expect(said).toEqual(['this computer joins your account as a machine, as anyone\'s does; it asks for sudo for Tailscale and k3s']);
  });

  it('stops saying how the machine command ended when it fails', async () => {
    const root = await rootGivingCommands(() => 'exit 3');
    await expect(joinThisComputer('session=dev', 'http://dev.localhost:5173', { rootApi: root.rootApi, config: root.config, folder: root.folder, say: () => undefined }))
      .rejects.toThrow('the machine command stopped (3)');
  });
});
