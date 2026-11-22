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
import { koalaPlacedAndUp, testInstanceClients } from '../instances/testing/placed-koala.js';
import { MachineAccounts } from '../machines/services/MachineAccounts.js';
import { myMachinesRouter } from '../machines/routes/my-machines.js';
import { quietAccountSides } from '../machines/testing/wiring-world.js';
import { machineClientsAt } from '../instances/testing/registration-code.js';
import { hashMachineCode } from '../machines/lib/machines.js';
import { DEV } from '../instances/index.js';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE, SETUP_AGAIN_ASKED, type ProvisionReport } from '@koala/engine-core/koala-install';

interface Root {
  rootApi: string;
  report: (status: string, detail: string) => Promise<void>;
  setup: (report: ProvisionReport) => Promise<void>;
  told: [string, string][];
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
  const told: [string, string][] = [];
  const instances = new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag: 't', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev', connected: () => true, tell: (instanceId, event) => { told.push([instanceId, event]); } }, mesh);
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
      const reported = await instances.report(joined.value.instanceId, joined.value.token, { status, detail });
      if (!reported.ok) throw new Error(reported.error);
    },
    setup: async (report) => {
      const reported = await instances.report(joined.value.instanceId, joined.value.token, { provision: report });
      if (!reported.ok) throw new Error(reported.error);
    },
    told,
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

describe('dev finding this computer\'s Koala stopped setting itself up', () => {
  const reportingEach = (root: Root, next: ProvisionReport[]) => async (): Promise<void> => {
    const report = next.shift();
    if (report) await root.setup(report);
  };
  const gitea = { stage: 'gitea', title: 'Gitea, your repositories and images' };

  it('asks root to set it up again from where it stopped, and follows the new attempt until it is ready', async () => {
    const root = await rootWithAJoinedKoala();
    await root.setup({ revision: 2, run: 'run-a', progress: { ...gitea, state: 'failed', why: 'the volume is full' } });
    const said: string[] = [];
    const next: ProvisionReport[] = [
      { revision: 2, run: 'run-b', progress: { ...gitea, state: 'started', line: 'waiting for gitea-0' } },
      { revision: 2, run: 'run-b', progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } },
    ];
    const pause = reportingEach(root, next);

    await untilKoalaReady('session=dev', { rootApi: root.rootApi, say: (line) => said.push(line), pause });

    expect(root.told).toEqual([[expect.any(String), SETUP_AGAIN_ASKED]]);
    expect(said).toEqual([
      'your Koala is failed: Koala on desk stopped setting itself up at Gitea, your repositories and images: the volume is full',
      'dev asks it to set itself up again from where it stopped',
      'your Koala is installing: Asking Koala on desk to set itself up again from Gitea, your repositories and images',
      'your Koala is installing: Koala on desk is setting itself up: Gitea, your repositories and images, waiting for gitea-0',
      'your Koala is ready: Ready',
    ]);
  });

  it('stops with root\'s reason when the new attempt stops too, asking only once', async () => {
    const root = await rootWithAJoinedKoala();
    await root.setup({ revision: 2, run: 'run-a', progress: { ...gitea, state: 'failed', why: 'the volume is full' } });
    const next: ProvisionReport[] = [{ revision: 2, run: 'run-b', progress: { ...gitea, state: 'failed', why: 'the volume is still full' } }];
    const pause = reportingEach(root, next);

    await expect(untilKoalaReady('session=dev', { rootApi: root.rootApi, say: () => undefined, pause }))
      .rejects.toThrow('putting Koala on this computer failed: Koala on desk stopped setting itself up at Gitea, your repositories and images: the volume is still full');
    expect(root.told).toHaveLength(1);
  });

  it('asks again for a later failure of the same revision, and never takes the failure it asked about for the answer', async () => {
    const root = await rootWithAJoinedKoala();
    const monitoring = { stage: 'monitoring', title: 'Monitoring' };
    await root.setup({ revision: 2, run: 'run-a', progress: { ...gitea, state: 'failed', why: 'the volume is full' } });
    const first: ProvisionReport[] = [
      { revision: 2, run: 'run-a', progress: { ...gitea, state: 'failed', why: 'the volume is full' } },
      { revision: 2, run: 'run-b', progress: { ...gitea, state: 'started', line: 'waiting for gitea-0' } },
      { revision: 2, run: 'run-b', progress: { ...monitoring, state: 'failed', why: 'prometheus would not start' } },
    ];

    await expect(untilKoalaReady('session=dev', { rootApi: root.rootApi, say: () => undefined, pause: reportingEach(root, first) }))
      .rejects.toThrow('putting Koala on this computer failed: Koala on desk stopped setting itself up at Monitoring: prometheus would not start');

    const said: string[] = [];
    const second: ProvisionReport[] = [
      { revision: 2, run: 'run-b', progress: { ...monitoring, state: 'failed', why: 'prometheus would not start' } },
      { revision: 2, run: 'run-c', progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } },
    ];
    await untilKoalaReady('session=dev', { rootApi: root.rootApi, say: (line) => said.push(line), pause: reportingEach(root, second) });

    expect(root.told).toEqual([[expect.any(String), SETUP_AGAIN_ASKED], [expect.any(String), SETUP_AGAIN_ASKED]]);
    expect(said).toEqual([
      'your Koala is failed: Koala on desk stopped setting itself up at Monitoring: prometheus would not start',
      'dev asks it to set itself up again from where it stopped',
      'your Koala is installing: Asking Koala on desk to set itself up again from Monitoring',
      'your Koala is ready: Ready',
    ]);
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
    const accounts = new MachineAccounts({ ...quietAccountSides(), store: db.machines, clients: machineClientsAt(db) });
    const app = await harnessApp({ prefix: '/api', router: () => Router().use('/my-machines', myMachinesRouter({ accounts, koalaOf: async () => undefined })) }, db, () => TEST_USER);
    const server = await listen(app, 0);
    return { db, out, config: path.join(place, 'config'), folder: path.join(place, 'koala'), rootApi: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('has the machine command pull every image through this computer\'s caches, so a reset downloads nothing that did not change', async () => {
    const root = await rootGivingCommands((out) => `printf '%s\\n' "$@" > '${out}'`);
    await joinThisComputer('session=dev', 'http://dev.localhost:5173', { rootApi: root.rootApi, config: root.config, folder: root.folder, say: () => undefined, imageMirrors: { 'docker.io': 'http://127.0.0.1:5101', 'ghcr.io': 'http://127.0.0.1:5102' } });
    const [, ...rest] = (await readFile(root.out, 'utf8')).trim().split('\n');
    expect(rest).toEqual(['--folder', root.folder, '--image-mirror', 'docker.io=http://127.0.0.1:5101', '--image-mirror', 'ghcr.io=http://127.0.0.1:5102']);
  });

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
