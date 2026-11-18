import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { koalaInstallProgressPath } from '@koala/engine-core/koala-install';
import { runSteps, type Step } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { joinArgsOf } from '../../../../local-agent/src/join/args.js';
import { localJoinHost } from '../../../../local-agent/src/join/host.js';
import { joinRootStep } from '../../../../local-agent/src/join/steps/join-root.js';
import { joinPins } from '../../../../local-agent/src/join/pins.js';
import type { JoinContext } from '../../../../local-agent/src/join/context.js';
import { rootProgress, rootReporter, rootUrlOf } from '../../../../local-agent/src/root-progress.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { KoalaInstalls } from '../services/KoalaInstalls.js';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import { machinesRouter } from './machines.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function root() {
  const db: Database = await testDatabase();
  const heard: Array<[string, MachineProgress]> = [];
  const instances = new InstanceService(db, {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined });
  const installs = new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    places: () => instances,
    workflows: { start: async () => undefined, progress: async (installId, progress) => { heard.push([installId, progress]); }, reconnected: async () => undefined, cancel: async () => undefined },
    toMachines: { placeKoala: async () => false },
    toOwner: { installChanged: () => undefined },
  });
  const accounts = new MachineAccounts({
    store: db.machines, signing: identityKeysFrom(generateIdentityKey()), settings: { url: 'http://root.test', meshLoginServer: 'https://mesh.test' },
    mesh: { createPreAuthKey: async () => ({ key: 'hskey' }), removeNode: async () => undefined },
    koala: { of: async () => undefined }, followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: () => false, koala: () => false, online: () => false },
    installs,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/machines', machinesRouter({ accounts, installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => { server.close(() => done()); }));
  return { db, accounts, installs, heard, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function joinContext(url: string, code: string): Promise<JoinContext> {
  const home = await mkdtemp(path.join(tmpdir(), 'koala-agent-to-root-'));
  closers.push(() => rm(home, { recursive: true, force: true }));
  const args = joinArgsOf([code, '--url', url, '--yes', '--folder', path.join(home, 'koala')]);
  const host = localJoinHost({ env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, machineRoot: path.join(home, 'machine'), user: { uid: 1000, name: 'bo', group: 'bo', home }, hostname: 'desk' });
  return { args, host, commands: { run: async () => { throw new Error('the join step runs no command'); } }, pins: joinPins(undefined), folder: path.join(home, 'koala'), agentDir: path.join(home, 'agent'), node: process.execPath };
}

describe('the machine agent\'s own HTTP calls, against root\'s real routes in the same process', () => {
  it('joins with the code from My Machines, keeping the token root gives, and tells root the join\'s stages with that code', async () => {
    const { db, accounts, url } = await root();
    const { code } = await accounts.createJoinCode('bo');
    const ctx = await joinContext(url, code);
    const reporter = rootReporter(rootProgress(rootUrlOf(url, JOIN_PROGRESS_PATH), code, fetch, { pause: async () => undefined }));
    await runSteps([joinRootStep(url)], ctx, reporter);
    expect(ctx.joined).toMatchObject({ rootUrl: 'http://root.test', meshLoginServer: 'https://mesh.test', meshAuthKey: 'hskey' });
    const saved = JSON.parse(await readFile(path.join(ctx.host.env.XDG_CONFIG_HOME!, 'koala', 'machine.json'), 'utf8')) as { token: string; deviceId: string };
    expect(saved.token).toBe(ctx.joined!.token);
    expect((await db.machines.getLocalAgentDevices()).map((device) => [device.id, device.ownerId, device.name])).toEqual([[saved.deviceId, 'bo', 'desk']]);
    expect((await accounts.joins('bo')).map((join) => [join.stage, join.state])).toEqual([['join', 'done']]);
  });

  it('tells root each stage of putting Koala on the machine at the install\'s own route, with the machine\'s own token, and is refused a stage of an install it was not asked for', async () => {
    const { db, accounts, installs, heard, url } = await root();
    const { code } = await accounts.createJoinCode('bo');
    const ctx = await joinContext(url, code);
    await runSteps([joinRootStep(url)], ctx, memoryReporter());
    await accounts.recordMeshIp((await accounts.list('bo'))[0]!.id, '100.64.0.7');
    const started = await installs.start('bo', (await db.machines.getLocalAgentDevices())[0]!, 'bobby');
    if (!started.ok) throw new Error(started.error);
    const koala: Step<{ ready: boolean }> = { id: 'koala', title: 'Putting Koala on this machine', check: async (state) => (state.ready ? { done: true } : { done: false, why: 'not yet' }), apply: async (state, progress) => { progress.line('waiting for job/instance-seed-1 runs'); state.ready = true; } };
    const install = (installId: string) => rootReporter(rootProgress(rootUrlOf(url, koalaInstallProgressPath(installId)), () => ctx.joined!.token, fetch, { pause: async () => undefined }), { lines: true, ending: { stage: 'koala', url: 'http://100.64.0.7:30320' } });
    await runSteps([koala], { ready: false }, install(started.value.installId));
    expect(heard).toEqual([
      [started.value.installId, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started' }],
      [started.value.installId, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' }],
      [started.value.installId, { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' }],
    ]);
    await expect(runSteps([koala], { ready: false }, install('another-install'))).rejects.toThrow('root did not take this machine\'s progress (404): no such install of Koala on this machine');
  });
});
