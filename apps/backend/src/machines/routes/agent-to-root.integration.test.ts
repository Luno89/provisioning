import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { KOALA_INSTALL_FOLLOW_PATH, koalaInstallProgressPath } from '@koala/engine-core/koala-install';
import { runSteps, type Step } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { joinArgsOf } from '../../../../local-agent/src/join/args.js';
import { localJoinHost } from '../../../../local-agent/src/join/host.js';
import { joinRootStep } from '../../../../local-agent/src/join/steps/join-root.js';
import { joinPins } from '../../../../local-agent/src/join/pins.js';
import type { JoinContext } from '../../../../local-agent/src/join/context.js';
import { rootProgress, rootReporter, rootUrlOf } from '../../../../local-agent/src/root-progress.js';
import { followInstall } from '../../../../local-agent/src/join/follow-install.js';
import { installFields, stageHeard } from '../../instances/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { KoalaInstalls } from '../services/KoalaInstalls.js';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import { machinesRouter } from './machines.js';
import { createAuth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import { closedAfterEach, quietAccountSides } from '../testing/wiring-world.js';
import { openRoutesOf } from '../../open-routes.js';

const closers = closedAfterEach();

async function root(followBeatMs?: number) {
  const db: Database = await testDatabase();
  const heard: Array<[string, MachineProgress]> = [];
  const instances = new InstanceService(db, {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined });
  const installs = new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    places: () => instances,
    workflows: { start: async () => undefined, progress: async (installId, progress) => { heard.push([installId, progress]); }, setup: async () => undefined, reconnected: async () => undefined, cancel: async () => undefined },
    toMachines: { placeKoala: async () => false, stopKoala: () => false },
    toOwner: { installChanged: () => undefined },
  });
  const accounts = new MachineAccounts({
    ...quietAccountSides(),
    store: db.machines, signing: identityKeysFrom(generateIdentityKey()),
    toOwner: { machinesChanged: (ownerId) => { installs.wake(ownerId); } },
    installs,
  });
  const watched = db.instances.watchInstalls((instance) => { void installs.relay(instance); });
  closers.push(() => watched.close());
  await watched.ready;
  const app = express();
  app.use('/api', createAuth({ db, sessionKey: 'agent-to-root', publicUrl: 'http://root.test', role: 'root', open: openRoutesOf('root'), sessionEnds: new SessionEnds(db.platform) }).requireAuth);
  app.use(express.json());
  app.use('/api/machines', machinesRouter({ accounts, installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) }, followBeatMs }));
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => { server.close(() => done()); }));
  return { db, accounts, installs, instances, heard, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
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

  it('stops at the join when the settings this machine kept are not the ones Koala writes, tells root where and why with the code, and makes no machine', async () => {
    const { db, accounts, url } = await root();
    const { code } = await accounts.createJoinCode('bo');
    const ctx = await joinContext(url, code);
    const settings = path.join(ctx.host.env.XDG_CONFIG_HOME!, 'koala', 'machine.json');
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, '{"token": ');
    const reporter = rootReporter(rootProgress(rootUrlOf(url, JOIN_PROGRESS_PATH), code, fetch, { pause: async () => undefined }));
    await expect(runSteps([joinRootStep(url)], ctx, reporter)).rejects.toThrow(`${settings} is not the settings Koala writes (`);
    expect(await db.machines.getLocalAgentDevices()).toEqual([]);
    const [join] = await accounts.joins('bo');
    expect(join).toMatchObject({ stage: 'join', state: 'failed', joined: false });
    expect(join?.why).toContain(`${settings} is not the settings Koala writes (`);
    expect(join?.why).toContain(`remove it there; then delete ${settings} and run this command again.`);
    expect(await readFile(settings, 'utf8')).toBe('{"token": ');
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

  describe('the join following root putting Koala on the machine, over root\'s real follow route', () => {
    const settledOn = async (following: Promise<unknown>, what: () => boolean): Promise<void> => {
      let ended: { how: string } | undefined;
      following.then((end) => { ended = { how: `ended ${String(end)}` }; }, (err: Error) => { ended = { how: `failed: ${err.message}` }; });
      while (!what()) {
        if (ended) throw new Error(`the follow ${ended.how} before what the test waits for`);
        await new Promise((done) => setTimeout(done, 10));
      }
    };

    async function joinedWithKoala(name?: string, followBeatMs?: number) {
      const world = await root(followBeatMs);
      const { code } = await world.accounts.createJoinCode('bo', name);
      const ctx = await joinContext(world.url, code);
      await runSteps([joinRootStep(world.url)], ctx, memoryReporter());
      const said: string[] = [];
      const following = followInstall({
        rootUrl: world.url, token: ctx.joined!.token, fetch, say: (line) => { said.push(line); }, section: (title) => { said.push(`# ${title}`); },
        interrupted: new AbortController().signal, wait: { pause: async () => undefined },
      });
      return { ...world, deviceId: ctx.joined!.deviceId, token: ctx.joined!.token, said, following };
    }

    async function heard(world: Awaited<ReturnType<typeof root>>, installId: string, progress: MachineProgress, setUp = false): Promise<void> {
      const instance = await world.instances.installOf(installId);
      const at = new Date().toISOString();
      const patch = stageHeard({ ...instance!.install!, ...(setUp ? { setUp: true } : {}) }, progress, 'desk', at);
      await world.db.instances.updateInstall(instance!.id, installId, installFields(patch, at));
    }

    it('prints each stage and line root records, from waiting for the machine to join the mesh until Koala is ready', async () => {
      const world = await joinedWithKoala('bobby');
      await world.accounts.recordMeshIp(world.deviceId, '100.64.0.7');
      const delivered = await world.accounts.deliverKoala(world.deviceId);
      expect(delivered).toEqual({ ok: true, value: { placing: true } });
      const installId = (await world.db.instances.getInstances('bo'))[0]!.install!.id;
      await settledOn(world.following, () => world.said.includes('# Putting Koala on this machine'));
      await heard(world, installId, { stage: 'chart', title: 'Installing Koala\'s chart', state: 'started', line: 'waiting for deployment/koala' });
      await settledOn(world.following, () => world.said.includes('  waiting for deployment/koala'));
      await heard(world, installId, { stage: 'koala', title: 'Koala', state: 'done', url: 'http://100.64.0.7:30320' }, true);
      expect(await world.following).toBe('ready');
      expect(world.said).toEqual(['# Putting Koala on this machine', 'Installing Koala\'s chart', '  waiting for deployment/koala', 'Koala is ready at http://100.64.0.7:30320']);
    });

    it('ends with why when root will not put Koala on the machine, and has nothing to follow when the join asked for none', async () => {
      const refused = await joinedWithKoala('bobby');
      await refused.db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', url: 'https://laptop.koala.test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'ready', machine: 'laptop', machineId: 'laptop' });
      await refused.accounts.recordMeshIp(refused.deviceId, '100.64.0.7');
      expect(await refused.accounts.deliverKoala(refused.deviceId)).toMatchObject({ ok: false, status: 409 });
      expect(await refused.following).toBe('stopped');
      expect(refused.said).toEqual(['your Koala is on laptop; moving it is a step of its own']);

      const plain = await joinedWithKoala();
      expect(await plain.following).toBe('none');
      expect(plain.said).toEqual([]);
    });

    it('keeps the follow of an install that has gone quiet open with a beat, so the machine hears root is still there', async () => {
      const world = await joinedWithKoala('bobby', 25);
      await world.accounts.recordMeshIp(world.deviceId, '100.64.0.7');
      expect(await world.accounts.deliverKoala(world.deviceId)).toEqual({ ok: true, value: { placing: true } });
      await settledOn(world.following, () => world.said.includes('# Putting Koala on this machine'));
      const quiet = new AbortController();
      const answer = await fetch(`${world.url}${KOALA_INSTALL_FOLLOW_PATH}`, { headers: { authorization: `Bearer ${world.token}`, accept: 'text/event-stream' }, signal: quiet.signal });
      expect(answer.status).toBe(200);
      const decoder = new TextDecoder();
      let streamed = '';
      for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
        streamed += decoder.decode(chunk, { stream: true });
        if (streamed.includes(': beat\n\n')) break;
      }
      quiet.abort();
      expect(streamed).toMatch(/^data: \{"install":\{.+\}\n\n(: beat\n\n)+$/s);
      expect(world.said).toEqual(['# Putting Koala on this machine']);
      const installId = (await world.db.instances.getInstances('bo'))[0]!.install!.id;
      await heard(world, installId, { stage: 'koala', title: 'Koala', state: 'failed', why: 'the image could not be pulled' });
      expect(await world.following).toBe('failed');
    });

    it('is refused a token that is not a machine\'s', async () => {
      const world = await root();
      await expect(followInstall({ rootUrl: world.url, token: 'not-a-machine', fetch, say: () => undefined, section: () => undefined, interrupted: new AbortController().signal }))
        .rejects.toThrow('root would not say how putting Koala on this machine goes (401): this machine is not one of Koala\'s: run the command from My Machines again');
    });
  });
});
