import { describe, it, expect, beforeEach } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { InstanceService, hashCredential, instanceIdFor } from './InstanceService.js';
import type { InstanceRecord } from '../lib/instances.js';
import { koalaPlacedAndUp } from '../testing/placed-koala.js';
import { instanceServiceBehaviour, settings, mesh, matching, containing } from '../testing/instance-service-behaviour.js';

const world = instanceServiceBehaviour(async () => memoryDatabase(), () => new Date('2026-10-02T12:00:00Z'));

describe('bringing a user\'s own machine in as their instance', () => {
  it('tells its owner\'s machines where their Koala is when a report brings it into service, as when it reached root still installing', async () => {
    const told: string[] = [];
    world.service = new InstanceService(world.db, { ...settings, serviceChanged: (instance) => { told.push(`${instance.ownerId}:${instance.status}`); } }, mesh, () => world.now, () => undefined);
    const placed = await world.placedOn('u1');
    const { instanceId, credential } = placed;

    await world.service.report(instanceId, credential, { status: 'installing', detail: 'installing Koala on this machine' });
    await world.service.report(instanceId, credential, { status: 'installing', detail: 'still installing' });
    await world.service.report(instanceId, credential, { status: 'ready', detail: 'Running dev' });
    await world.service.report(instanceId, credential, { status: 'ready', detail: 'Running dev' });

    expect(told).toEqual(['u1:installing', 'u1:ready']);
  });
});

describe('an instance asking root about itself', () => {
  const pooled = { id: 'inst-p', ownerId: 'p1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'), running: 'abc123', pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 'then', trialEndsAt: '2026-11-03T00:00:00.000Z' } } as const;

  it('says which release it runs, to its own credential only', async () => {
    await world.db.instances.saveInstance({ ...pooled });
    expect(await world.service.runningOf('inst-p', 'secret')).toEqual({ ok: true, value: { running: 'abc123' } });
    expect(await world.service.runningOf('inst-p', 'wrong')).toEqual({ ok: false, status: 401, error: 'unknown instance or credential' });
  });

  it('names its place on Koala\'s servers, to its own credential only', async () => {
    await world.db.instances.saveInstance({ ...pooled });
    expect(await world.service.poolPlaceOf('inst-p', 'secret')).toEqual({ ok: true, value: { name: 'alice', hostNamespace: 'pool-alice' } });
    expect(await world.service.poolPlaceOf('inst-p', 'wrong')).toMatchObject({ ok: false, status: 401 });
  });

  it('has no place there when it runs on its owner\'s machine, or is stopped', async () => {
    await world.db.instances.saveInstance({ ...pooled, id: 'inst-own', ownerId: 'o1', name: 'own', pool: undefined });
    expect(await world.service.poolPlaceOf('inst-own', 'secret')).toEqual({ ok: false, status: 404, error: 'this instance does not run on Koala\'s servers' });
    await world.db.instances.saveInstance({ ...pooled, status: 'paused' });
    expect(await world.service.poolPlaceOf('inst-p', 'secret')).toEqual({ ok: false, status: 409, error: 'this instance is stopped' });
  });
});

describe('putting a person\'s Koala on one of their machines', () => {
  const desk = { id: 'desk', name: 'desk', meshIp: '100.64.0.7' };

  it('finds an instance by its install, and takes where Koala answers on the machine only at the instance\'s own mesh address', async () => {
    await world.service.placeOn('u1', desk, 'luno', 'install-1');
    const instance = await world.service.installOf('install-1');
    expect(instance).toMatchObject({ id: instanceIdFor('u1'), install: { id: 'install-1' } });
    expect(await world.service.installOf('install-0')).toBeUndefined();
    expect(await world.service.installedUrl(instance!, 'http://100.64.0.7:30320/')).toEqual({ ok: true, value: 'http://100.64.0.7:30320' });
    expect(await world.service.installedUrl(instance!, 'http://100.64.0.8:30320')).toMatchObject({ ok: false, status: 400, error: matching(/^root does not call http:\/\/100\.64\.0\.8:30320/) });
    expect(await world.service.installedUrl(instance!, 'javascript:alert(1)')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('an instance telling root how its setup after the chart goes', () => {
  const gitea = (state: 'started' | 'done' | 'failed', more: Record<string, string> = {}) => ({ stage: 'gitea', title: 'Gitea, your repositories and images', state, ...more });
  const setUp = { stage: 'set-up', title: 'Koala is set up', state: 'done' };

  const joinedOn = () => koalaPlacedAndUp(world.service, world.db, 'u1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'luno');

  it('shows each piece as it comes, fails at the piece that stopped, and is ready only once the setup says so', async () => {
    const { instanceId, credential } = await joinedOn();
    expect(await world.service.report(instanceId, credential, { provision: { revision: 1, progress: gitea('started', { line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' }) } }))
      .toMatchObject({ ok: true, value: { status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready', setup: { revision: 1, state: 'running', stage: 'gitea' } } });
    expect(await world.service.report(instanceId, credential, { provision: { revision: 1, progress: gitea('failed', { why: 'pod gitea-0 is Init:Error' }) } }))
      .toMatchObject({ ok: true, value: { status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error' } });
    expect(await world.service.report(instanceId, credential, { provision: { revision: 1, progress: setUp } })).toMatchObject({ ok: true, value: { status: 'ready', detail: 'Ready', setup: { revision: 1, state: 'up' } } });
    expect(await world.service.report(instanceId, credential, { provision: { revision: 0, progress: setUp } })).toMatchObject({ ok: false, status: 400, error: containing('"revision"') });
    expect(await world.service.report(instanceId, credential, { provision: { revision: 1, progress: { stage: 'koala', title: 'Koala', state: 'done' } } })).toMatchObject({ ok: false, status: 400, error: containing('"stage" is one of') });
    expect(await world.service.report(instanceId, credential, { status: 'ready', provision: { revision: 1, progress: setUp } })).toEqual({ ok: false, status: 400, error: 'a report of Koala\'s setup sends only "provision"' });
  });

  it('refuses, saying why, a setup for a revision it has moved past, keeping the one it follows', async () => {
    const { instanceId, credential } = await joinedOn();
    await world.service.report(instanceId, credential, { provision: { revision: 2, progress: gitea('started') } });
    expect(await world.service.report(instanceId, credential, { provision: { revision: 1, progress: setUp } })).toEqual({ ok: false, status: 409, error: 'root follows the setup of revision 2, so revision 1\'s is no longer this Koala\'s' });
    expect((await world.db.instances.getInstances('u1'))[0]!.setup).toMatchObject({ revision: 2, state: 'running' });
  });

  it('holds a report naming the revision it runs to that revision\'s setup, never ready before it nor over a piece that failed, while the release it runs is kept', async () => {
    const { instanceId, credential } = await joinedOn();
    expect(await world.service.report(instanceId, credential, { status: 'installing', detail: 'Upgraded to v8', imageTag: 'v8', revision: 2 })).toMatchObject({ ok: true, value: { status: 'installing', detail: 'Upgraded to v8', running: 'v8' } });
    await world.service.report(instanceId, credential, { provision: { revision: 2, progress: gitea('failed', { why: 'pod gitea-0 is Init:Error' }) } });
    expect(await world.service.report(instanceId, credential, { status: 'installing', detail: 'Running v8', imageTag: 'v8', revision: 2 })).toMatchObject({ ok: true, value: { status: 'failed', detail: containing('stopped setting itself up at Gitea') } });
    await world.service.report(instanceId, credential, { provision: { revision: 2, progress: setUp } });
    expect(await world.service.report(instanceId, credential, { status: 'installing', detail: 'Running v8', imageTag: 'v8', revision: 2 })).toMatchObject({ ok: true, value: { status: 'ready', detail: 'Running v8' } });
    expect(await world.service.report(instanceId, credential, { status: 'ready', detail: 'Running v8', revision: 2 })).toMatchObject({ ok: false, status: 400, error: containing('ready comes from') });
    expect(await world.service.report(instanceId, credential, { status: 'installing', revision: 'two' })).toMatchObject({ ok: false, status: 400 });
  });

  it('hands the setup of a Koala still being put on its machine to that install, and writes nothing itself', async () => {
    const handed: unknown[] = [];
    let down = false;
    world.service = new InstanceService(world.db, { ...settings, installs: { setupHeard: async (installId, report) => {
      if (down) return { ok: false, status: 503, error: 'root could not hand this to the install it follows: Temporal is down' };
      handed.push([installId, report]);
      return { ok: true, value: { recorded: true } };
    }, progressHeard: async () => ({ ok: true, value: { recorded: true } }), stop: async () => ({ ok: true, value: { recorded: true } }) } }, mesh, () => world.now);
    const placed = await world.service.placeOn('u1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'luno', 'install-1');
    if (!placed.ok) throw new Error(placed.error);
    const koala = await world.service.placedKoala('install-1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' });
    if (!koala.ok) throw new Error(koala.error);
    const line = { revision: 1, progress: gitea('started') };
    expect(await world.service.report(placed.value.instanceId, koala.value.credential, { provision: line })).toMatchObject({ ok: true, value: { status: 'joined' } });
    expect(handed).toEqual([['install-1', line]]);
    expect((await world.db.instances.getInstances('u1'))[0]!.setup).toBeUndefined();
    down = true;
    expect(await world.service.report(placed.value.instanceId, koala.value.credential, { provision: line })).toMatchObject({ ok: false, status: 503 });
  });

  it('forgets the setup of a Koala it puts on a machine afresh, since a fresh chart counts its revisions from 1 again', async () => {
    const { instanceId, credential } = await joinedOn();
    await world.service.report(instanceId, credential, { provision: { revision: 4, progress: setUp } });
    await world.service.placeOn('u1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'luno', 'install-2');
    expect((await world.db.instances.getInstances('u1'))[0]!.setup).toBeUndefined();
  });
});

describe('a pool instance setting itself up', () => {
  const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: '2026-10-01T00:00:00.000Z', trialEndsAt: '2026-10-15T00:00:00.000Z' };
  const line = { revision: 1, progress: { stage: 'searxng', title: 'SearXNG, web search', state: 'started' } };
  let handed: unknown[];

  beforeEach(async () => {
    handed = [];
    world.service = new InstanceService(world.db, { ...settings, pool: { slots: 2, trialDays: 14 } }, mesh, () => world.now, () => undefined, {
      start: async () => {}, trialChanged: async () => {}, remove: async () => {},
      setupHeard: async (instanceId, report) => { handed.push([instanceId, report]); },
    });
  });

  const saved = async (more: Partial<InstanceRecord>) => {
    await world.db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', name: 'bo', url: '', status: 'installing', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('pool-secret'), pool: { ...pool, settingUp: true }, ...more });
  };

  it('is made waiting for its setup, which its own workflow hears while it is being placed', async () => {
    expect(await world.service.createPoolInstance('u1', 'alice')).toMatchObject({ ok: true });
    expect((await world.db.instances.getInstances('u1'))[0]!.pool).toMatchObject({ settingUp: true });
    await saved({});
    expect(await world.service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'installing' } });
    expect(handed).toEqual([['inst-bo', line]]);
  });

  it('records the setup of a placement that failed without undoing why it failed, and records it as its status once the placement has ended', async () => {
    await saved({ status: 'failed', detail: 'no gVisor' });
    expect(await world.service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'failed', detail: 'no gVisor', setup: { revision: 1, stage: 'searxng', state: 'running' } } });
    await saved({ status: 'ready', url: 'https://bo.koala.dev', pool });
    expect(await world.service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'installing', detail: 'Koala is setting itself up: SearXNG, web search' } });
    expect(handed).toEqual([]);
  });

  it('records the pool copy\'s setup while it moves, leaving the instance serving where it is', async () => {
    await saved({ status: 'ready', pool, move: { state: 'copying', startedAt: 'now' } });
    expect(await world.service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'ready', setup: { revision: 1, stage: 'searxng', state: 'running' } } });
    expect(handed).toEqual([]);
  });

  it('hands the setup of the Koala it moves to to the move\'s install, leaving the instance serving where it is', async () => {
    const setups: unknown[] = [];
    world.service = new InstanceService(world.db, { ...settings, pool: { slots: 2, trialDays: 14 }, installs: {
      setupHeard: async (installId, report) => { setups.push([installId, report]); return { ok: true, value: { recorded: true } }; },
      progressHeard: async () => ({ ok: true, value: { recorded: true } }),
      stop: async () => ({ ok: true, value: { recorded: true } }),
    } }, mesh, () => world.now, () => undefined, { start: async () => {}, trialChanged: async () => {}, remove: async () => {} });
    await saved({ status: 'ready', pool, move: { state: 'copying', startedAt: 'now', detail: 'Copying its data', credentialHash: hashCredential('move-secret'), target: { machine: 'bo-desktop' } }, install: { id: 'install-1', machineId: 'desk', state: 'installing', at: 'now', move: true } });
    expect(await world.service.report('inst-bo', 'move-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(setups).toEqual([['install-1', line]]);
    expect(await world.service.report('inst-bo', 'move-secret', { provision: { revision: 0, progress: line.progress } })).toMatchObject({ ok: false, status: 400 });
    expect(handed).toEqual([]);
  });
});
