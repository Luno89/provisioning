import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { clientKeysFrom, clientPublicJwkOf, MACHINE_REGISTRATION_REFUSED, machineClientOf } from '@koala/engine-core/root-client';
import { closedAfterEach, quietAccountSides, untilWhile } from '../testing/wiring-world.js';
import { joiningRoot } from '../testing/joining-root.js';
import { testInstanceClients } from '../../instances/testing/placed-koala.js';

const closers = closedAfterEach();

async function root(followBeatMs?: number) {
  const db: Database = await testDatabase();
  const heard: Array<[string, MachineProgress]> = [];
  const instances = new InstanceService(db, {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], ...testInstanceClients, meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined });
  const { app, url, root: atRoot } = await joiningRoot(db, closers);
  const installs = new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    callers: atRoot.provider,
    places: () => instances,
    workflows: { start: async () => undefined, progress: async (installId, progress) => { heard.push([installId, progress]); }, setup: async () => undefined, reconnected: async () => undefined, cancel: async () => undefined },
    toMachines: { placeKoala: async () => false, stopKoala: () => false },
    toOwner: { installChanged: () => undefined },
  });
  const accounts = new MachineAccounts({
    ...quietAccountSides(url),
    store: db.machines, signing: identityKeysFrom(generateIdentityKey()), clients: atRoot.provider,
    toOwner: { machinesChanged: (ownerId) => { installs.wake(ownerId); } },
    installs,
  });
  const watched = db.instances.watchInstalls((instance) => { void installs.relay(instance); });
  closers.push(() => watched.close());
  await watched.ready;
  app.use('/api', atRoot.auth.requireAuth);
  app.use(express.json());
  app.use('/api/machines', machinesRouter({ accounts, installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) }, followBeatMs }));
  return { db, accounts, installs, instances, heard, provider: atRoot.provider, url };
}

async function joinContext(url: string, code: string): Promise<JoinContext> {
  const home = await mkdtemp(path.join(tmpdir(), 'koala-agent-to-root-'));
  closers.push(() => rm(home, { recursive: true, force: true }));
  const args = joinArgsOf([code, '--url', url, '--yes', '--folder', path.join(home, 'koala')]);
  const host = localJoinHost({ env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, machineRoot: path.join(home, 'machine'), user: { uid: 1000, name: 'bo', group: 'bo', home }, hostname: 'desk' });
  return { args, host, commands: { run: async () => { throw new Error('the join step runs no command'); } }, pins: joinPins(undefined), folder: path.join(home, 'koala'), agentDir: path.join(home, 'agent'), node: process.execPath };
}

type Root = Awaited<ReturnType<typeof root>>;

const keyTokenOf = (ctx: JoinContext) => () => machineClientOf({ rootUrl: ctx.joined!.rootUrl, deviceId: ctx.joined!.deviceId, key: ctx.joined!.key }).token();

const refusingRegistration = (provider: Root['provider']): typeof fetch => async (input, init) => {
  const answer = await fetch(input, init);
  if (String(input).endsWith('/api/machines/join')) {
    const { env } = await answer.clone().json() as { env: { KOALA_DEVICE_ID: string } };
    await provider.machineRegistrationCode({ id: env.KOALA_DEVICE_ID, ownerId: 'bo' });
  }
  return answer;
};

const savedOf = async (ctx: JoinContext) => JSON.parse(await readFile(path.join(ctx.host.env.XDG_CONFIG_HOME!, 'koala', 'machine.json'), 'utf8')) as { deviceId: string; key: string };

async function joinedMachine(world: Root) {
  const ctx = await joinContext(world.url, (await world.accounts.createJoinCode('bo')).code);
  await runSteps([joinRootStep(world.url)], ctx, memoryReporter());
  const saved = await savedOf(ctx);
  return { ctx, saved, token: () => machineClientOf({ rootUrl: world.url, deviceId: saved.deviceId, key: saved.key }).tokenIfKnown() };
}

async function joinedAgain(world: Root, ctx: JoinContext) {
  ctx.args = joinArgsOf([(await world.accounts.createJoinCode('bo')).code, '--url', world.url, '--yes', '--folder', ctx.folder]);
  delete ctx.joined;
  await runSteps([joinRootStep(world.url)], ctx, memoryReporter());
  return { devices: await world.db.machines.getLocalAgentDevices(), saved: await savedOf(ctx) };
}

describe('the machine agent\'s own HTTP calls, against root\'s real routes in the same process', () => {
  it('joins with the code from My Machines, keeping the token root gives and the key it registered at root with as a client of its owner, and tells root the join\'s stages with that code', async () => {
    const { db, accounts, url } = await root();
    const { code } = await accounts.createJoinCode('bo');
    const ctx = await joinContext(url, code);
    const reporter = rootReporter(rootProgress(rootUrlOf(url, JOIN_PROGRESS_PATH), code, fetch, { pause: async () => undefined }));
    await runSteps([joinRootStep(url)], ctx, reporter);
    expect(ctx.joined).toMatchObject({ rootUrl: url, meshLoginServer: 'https://mesh.test', meshAuthKey: 'hskey' });
    const settings = path.join(ctx.host.env.XDG_CONFIG_HOME!, 'koala', 'machine.json');
    const saved = JSON.parse(await readFile(settings, 'utf8')) as { deviceId: string; key: string };
    expect([saved.deviceId, saved.key]).toEqual([ctx.joined!.deviceId, ctx.joined!.key]);
    expect(saved).not.toHaveProperty('token');
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    const [device] = await db.machines.getLocalAgentDevices();
    expect([device?.id, device?.ownerId, device?.name]).toEqual([saved.deviceId, 'bo', 'desk']);
    expect(device?.signIn?.jwk).toEqual(clientPublicJwkOf(clientKeysFrom(saved.key)));
    expect(await machineClientOf({ rootUrl: url, deviceId: saved.deviceId, key: saved.key }).token()).toMatch(/^\S{20,}$/);
    expect((await accounts.joins('bo')).map((join) => [join.stage, join.state])).toEqual([['join', 'done']]);
  });

  it('stops at the join with what to do when a newer join replaced the code it registers with, and root keeps no key for the machine', async () => {
    const { db, accounts, provider, url } = await root();
    const { code } = await accounts.createJoinCode('bo');
    const ctx = await joinContext(url, code);
    ctx.host = { ...ctx.host, fetch: refusingRegistration(provider) };
    const reporter = rootReporter(rootProgress(rootUrlOf(url, JOIN_PROGRESS_PATH), code, fetch, { pause: async () => undefined }));
    await expect(runSteps([joinRootStep(url)], ctx, reporter)).rejects.toThrow(MACHINE_REGISTRATION_REFUSED);
    expect((await db.machines.getLocalAgentDevices())[0]?.signIn).toBeUndefined();
    const [join] = await accounts.joins('bo');
    expect(join).toMatchObject({ stage: 'join', state: 'failed', why: MACHINE_REGISTRATION_REFUSED });
  });

  describe('running the command again on the same machine', () => {
    it('replaces the machine it joined as, proven with the key it registered, keeping its one entry on My Machines with the new key', async () => {
      const world = await root();
      const first = await joinedMachine(world);
      const again = await joinedAgain(world, first.ctx);
      expect(again.devices.map((device) => device.id)).toEqual([first.saved.deviceId]);
      expect(again.saved.key).not.toBe(first.saved.key);
      expect(again.devices[0]?.signIn?.jwk).toEqual(clientPublicJwkOf(clientKeysFrom(again.saved.key)));
    });

    it('joins a machine that joined before machines had keys as a new one, leaving its old entry for the person to remove', async () => {
      const { db, accounts, url } = await root();
      const before = await accounts.join((await accounts.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/koala' });
      if (!before.ok) throw new Error(before.error);
      const ctx = await joinContext(url, (await accounts.createJoinCode('bo')).code);
      const settings = path.join(ctx.host.env.XDG_CONFIG_HOME!, 'koala', 'machine.json');
      await mkdir(path.dirname(settings), { recursive: true });
      await writeFile(settings, JSON.stringify({ rootUrl: url, token: 'a-device-token-from-before-keys', deviceId: before.value.deviceId, rootDir: '/home/bo/koala' }), { mode: 0o600 });
      await runSteps([joinRootStep(url)], ctx, memoryReporter());
      const saved = await savedOf(ctx);
      const devices = await db.machines.getLocalAgentDevices();
      expect(devices.map((device) => device.id).sort()).toEqual([before.value.deviceId, saved.deviceId].sort());
      expect(saved.deviceId).not.toBe(before.value.deviceId);
      expect(devices.find((device) => device.id === saved.deviceId)?.signIn?.jwk).toEqual(clientPublicJwkOf(clientKeysFrom(saved.key)));
    });

    it('replaces the machine a token of its key names, and that key stops working at once, until the machine registers its new one', async () => {
      const world = await root();
      const first = await joinedMachine(world);
      const again = await world.accounts.join((await world.accounts.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/work', replaces: await first.token() });
      expect(again.ok && again.value.deviceId).toBe(first.saved.deviceId);
      expect(await world.db.machines.getLocalAgentDevices()).toHaveLength(1);
      expect(await first.token()).toBeUndefined();
    });

    it('joins as a new machine after root refused its registration, since root holds no key for the first, leaving that one for the person to remove', async () => {
      const world = await root();
      const ctx = await joinContext(world.url, (await world.accounts.createJoinCode('bo')).code);
      ctx.host = { ...ctx.host, fetch: refusingRegistration(world.provider) };
      await expect(runSteps([joinRootStep(world.url)], ctx, memoryReporter())).rejects.toThrow(MACHINE_REGISTRATION_REFUSED);
      const first = await savedOf(ctx);
      ctx.host = { ...ctx.host, fetch };
      const again = await joinedAgain(world, ctx);
      expect(again.saved.deviceId).not.toBe(first.deviceId);
      expect(again.devices.map((device) => device.id).sort()).toEqual([first.deviceId, again.saved.deviceId].sort());
      expect(again.devices.find((device) => device.id === first.deviceId)?.signIn).toBeUndefined();
      expect(again.devices.find((device) => device.id === again.saved.deviceId)?.signIn?.jwk).toEqual(clientPublicJwkOf(clientKeysFrom(again.saved.key)));
    });

    it('takes a token that is not of the machine\'s key as no proof, adding a machine rather than replacing it', async () => {
      const world = await root();
      const { saved } = await joinedMachine(world);
      const taken = await world.accounts.join((await world.accounts.createJoinCode('bo')).code, { hostname: 'elsewhere', rootDir: '/x', replaces: 'a-token-of-no-key' });
      expect(taken.ok && taken.value.deviceId).not.toBe(saved.deviceId);
      expect(await world.db.machines.getLocalAgentDevices()).toHaveLength(2);
    });

    it('never replaces another person\'s machine with that machine\'s token', async () => {
      const world = await root();
      const first = await joinedMachine(world);
      const stranger = await world.accounts.join((await world.accounts.createJoinCode('cy')).code, { hostname: 'desk', rootDir: '/x', replaces: await first.token() });
      expect(stranger.ok && stranger.value.deviceId).not.toBe(first.saved.deviceId);
      expect((await world.db.machines.getLocalAgentDevices()).map((device) => device.ownerId).sort()).toEqual(['bo', 'cy']);
    });

    it('joins as a new machine once the person removed it on My Machines', async () => {
      const world = await root();
      const first = await joinedMachine(world);
      expect(await world.accounts.remove('bo', first.saved.deviceId)).toBe(true);
      const again = await joinedAgain(world, first.ctx);
      expect(again.devices).toHaveLength(1);
      expect(again.devices[0]?.id).not.toBe(first.saved.deviceId);
    });
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
    const install = (installId: string, token: () => Promise<string> = keyTokenOf(ctx)) => rootReporter(rootProgress(rootUrlOf(url, koalaInstallProgressPath(installId)), token, fetch, { pause: async () => undefined }), { lines: true, ending: { stage: 'koala', url: 'http://100.64.0.7:30320' } });
    await expect(runSteps([koala], { ready: false }, install(started.value.installId, async () => 'a-token-of-no-key'))).rejects.toThrow('root did not take this machine\'s progress (401): this machine is not one of Koala\'s: run the command from My Machines again');
    await runSteps([koala], { ready: false }, install(started.value.installId));
    expect(heard).toEqual([
      [started.value.installId, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started' }],
      [started.value.installId, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' }],
      [started.value.installId, { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' }],
    ]);
    await expect(runSteps([koala], { ready: false }, install('another-install'))).rejects.toThrow('root did not take this machine\'s progress (404): no such install of Koala on this machine');
  });

  describe('the join following root putting Koala on the machine, over root\'s real follow route', () => {
    const settledOn = (following: Promise<unknown>, what: () => boolean): Promise<true> => untilWhile(following, () => (what() ? true : undefined));

    async function joinedWithKoala(name?: string, followBeatMs?: number) {
      const world = await root(followBeatMs);
      const { code } = await world.accounts.createJoinCode('bo', name);
      const ctx = await joinContext(world.url, code);
      await runSteps([joinRootStep(world.url)], ctx, memoryReporter());
      const said: string[] = [];
      const following = followInstall({
        rootUrl: world.url, token: keyTokenOf(ctx), fetch, say: (line) => { said.push(line); }, section: (title) => { said.push(`# ${title}`); },
        interrupted: new AbortController().signal, wait: { pause: async () => undefined },
      });
      return { ...world, deviceId: ctx.joined!.deviceId, token: keyTokenOf(ctx), said, following };
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
      const answer = await fetch(`${world.url}${KOALA_INSTALL_FOLLOW_PATH}`, { headers: { authorization: `Bearer ${await world.token()}`, accept: 'text/event-stream' }, signal: quiet.signal });
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
      await expect(followInstall({ rootUrl: world.url, token: async () => 'not-a-machine', fetch, say: () => undefined, section: () => undefined, interrupted: new AbortController().signal }))
        .rejects.toThrow('root would not say how putting Koala on this machine goes (401): this machine is not one of Koala\'s: run the command from My Machines again');
    });
  });
});
