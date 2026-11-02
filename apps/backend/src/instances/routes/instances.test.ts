import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { MailError, type MailReputation, type MailService } from '../../platform/index.js';
import { callRouter, PERSON } from '../testing/call-router.js';
import { bundleAsEnv, instancesRouter } from './instances.js';
import { PoolMonitoringError, type PoolMonitoringService } from '../services/PoolMonitoringService.js';
import type { JoinBundle, Outcome } from '../services/InstanceService.js';
import type { MoveRelay } from '../services/MoveRelay.js';
import type { DependencyWatch } from '../services/DependencyWatch.js';
import type { InstanceMailLimit } from '../services/InstanceMailLimit.js';

type Instances = Parameters<typeof instancesRouter>[0]['instances'];

const prefix = '/api/instances';
const asInstance = { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' };
const ok = <T,>(value: T): Outcome<T> => ({ ok: true, value });
const no = (status: 400 | 401 | 404 | 409 | 503, error: string): Outcome<never> => ({ ok: false, status, error });
const allow: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => next();
const refuse: RequestHandler = (_req: Request, res: Response) => { res.status(403).json({ error: 'Only the operator of this server can do that.' }); };

const bundle: JoinBundle = {
  instanceId: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: "-----BEGIN PUBLIC KEY-----\nab'c$(touch ran)\n-----END PUBLIC KEY-----",
  meshLoginServer: 'https://mesh.example.com', preAuthKey: "key'with`touch ran`", registry: '100.64.0.1:5001', image: '100.64.0.1:5001/nowrinkles/app',
  imageTag: 'abc', chartUrl: 'https://app.example.com/api/instances/chart.tgz', credential: "c$HOME'$(touch ran)", name: 'luno', domain: 'example.com',
};

const route = (deps: Partial<Parameters<typeof instancesRouter>[0]> = {}) => {
  const instances = mock<Instances>();
  return { instances, router: instancesRouter({ instances, chart: async () => '', ...deps }) };
};

describe('the join reply as the installer reads it', () => {
  it('quotes every value so no character in it is run, and carries the keys as base64', () => {
    const text = bundleAsEnv(bundle);
    expect(text).toContain(`MESH_PREAUTH_KEY='key'\\''with\`touch ran\`'`);
    expect(text).toContain(`INSTANCE_CREDENTIAL='c$HOME'\\''$(touch ran)'`);
    expect(text).toContain(`ROOT_PUBLIC_KEYS_B64='${Buffer.from(bundle.rootPublicKeys).toString('base64')}'`);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('leaves out what it does not have and says a move is a move', () => {
    expect(bundleAsEnv(bundle)).toContain("INSTANCE_MOVE=''");
    expect(bundleAsEnv(bundle)).toContain("INSTANCE_IMAGE_DIGEST=''");
    expect(bundleAsEnv({ ...bundle, move: true, imageDigest: 'sha256:abc', chartSha256: 'def' })).toEqual(expect.stringContaining("INSTANCE_MOVE='yes'"));
    expect(bundleAsEnv({ ...bundle, imageDigest: 'sha256:abc', chartSha256: 'def' })).toEqual(expect.stringContaining("INSTANCE_CHART_SHA256='def'"));
  });
});

describe('a person making their instance', () => {
  it('checks a name, and passes on what the query asked', async () => {
    const { instances, router } = route();
    instances.nameCheck.calledWith(PERSON.id, 'luno').mockResolvedValue({ ok: true } as never);
    expect((await callRouter(router, prefix, { path: '/name-check?name=luno' })).body).toEqual({ ok: true });
  });

  it('gives the command to run on their machine, or says why not', async () => {
    const { instances, router } = route();
    instances.createJoinToken.calledWith(PERSON.id, 'luno').mockResolvedValue(ok({ token: 't', command: 'curl ...', expiresAt: 'later' }) as never);
    instances.createJoinToken.calledWith(PERSON.id, 'taken').mockResolvedValue(no(409, 'taken'));
    expect((await callRouter(router, prefix, { method: 'POST', path: '/join-tokens', body: { name: 'luno' } })).body).toEqual({ token: 't', command: 'curl ...', expiresAt: 'later' });
    const refused = await callRouter(router, prefix, { method: 'POST', path: '/join-tokens', body: { name: 'taken' } });
    expect([refused.status, refused.body]).toEqual([409, { error: 'taken' }]);
  });

  it('offers a trial on Koala\'s servers and starts one, saying 202 for it', async () => {
    const { instances, router } = route();
    instances.poolOffer.calledWith(PERSON.id).mockResolvedValue({ available: true, trialDays: 14 });
    instances.createPoolInstance.calledWith(PERSON.id, 'alice').mockResolvedValue(ok({ name: 'alice' }) as never);
    instances.createPoolInstance.calledWith(PERSON.id, 'no-dashes').mockResolvedValue(no(400, 'no dashes'));
    expect((await callRouter(router, prefix, { path: '/pool' })).body).toEqual({ available: true, trialDays: 14 });
    const made = await callRouter(router, prefix, { method: 'POST', path: '/pool', body: { name: 'alice' } });
    expect([made.status, made.body]).toEqual([202, { name: 'alice' }]);
    expect((await callRouter(router, prefix, { method: 'POST', path: '/pool', body: { name: 'no-dashes' } })).status).toBe(400);
  });

  it('shows their instance and switches whether root emails them when it is unreachable', async () => {
    const { instances, router } = route();
    instances.mine.calledWith(PERSON.id).mockResolvedValue({ id: 'inst-1' } as never);
    instances.setWatchOf.calledWith(PERSON.id, false).mockResolvedValue(ok({ notifyWhenUnreachable: false, alwaysTold: false }) as never);
    instances.setWatchOf.calledWith(PERSON.id, 'no').mockResolvedValue(no(400, 'send true or false'));
    expect((await callRouter(router, prefix, { path: '/mine' })).body).toEqual({ instance: { id: 'inst-1' } });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/mine/watch', body: { notifyWhenUnreachable: false } })).body).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/mine/watch', body: { notifyWhenUnreachable: 'no' } })).status).toBe(400);
  });
});

describe('the pool, for the operator only', () => {
  it('turns anyone else away', async () => {
    const { instances, router } = route();
    for (const call of [{ path: '/pool/admin' }, { method: 'PUT' as const, path: '/pool/admin/trial-days', body: { days: 30 } }, { method: 'PUT' as const, path: '/pool/admin/instances/i1/trial', body: { trialEndsAt: 'x' } }, { method: 'DELETE' as const, path: '/pool/admin/instances/i1', body: { confirm: 'alice' } }]) {
      const answer = await callRouter(router, prefix, call);
      expect([answer.status, answer.body]).toEqual([403, { error: 'Admin only' }]);
    }
    expect(instances.poolAdmin).not.toHaveBeenCalled();
  });

  it('shows the pool, sets the default trial, moves a trial\'s end and removes an instance', async () => {
    const { instances, router } = route({ operatorOnly: allow });
    instances.poolAdmin.mockResolvedValue(ok({ slots: 1, instances: [] }) as never);
    instances.setTrialDays.calledWith(PERSON.id, 30).mockResolvedValue(ok({ trialDays: 30 }) as never);
    instances.setTrialEnd.calledWith('i1', '2026-12-01T00:00:00.000Z').mockResolvedValue(ok({ trialEndsAt: '2026-12-01T00:00:00.000Z' }) as never);
    instances.removePoolInstance.calledWith('i1', 'alice').mockResolvedValue(ok({ removing: true }) as never);
    instances.removePoolInstance.calledWith('i1', undefined).mockResolvedValue(no(400, 'type the name'));
    expect((await callRouter(router, prefix, { path: '/pool/admin' })).body).toEqual({ slots: 1, instances: [] });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/pool/admin/trial-days', body: { days: 30 } })).body).toEqual({ trialDays: 30 });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/pool/admin/instances/i1/trial', body: { trialEndsAt: '2026-12-01T00:00:00.000Z' } })).body).toEqual({ trialEndsAt: '2026-12-01T00:00:00.000Z' });
    const removed = await callRouter(router, prefix, { method: 'DELETE', path: '/pool/admin/instances/i1', body: { confirm: 'alice' } });
    expect([removed.status, removed.body]).toEqual([202, { removing: true }]);
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/pool/admin/instances/i1' })).status).toBe(400);
  });

  it('says why when a pool change is refused', async () => {
    const { instances, router } = route({ operatorOnly: allow });
    instances.poolAdmin.mockResolvedValue(no(503, 'this root runs no pool'));
    instances.setTrialDays.mockResolvedValue(no(400, 'days are 1 to 365'));
    instances.setTrialEnd.mockResolvedValue(no(404, 'no such trial'));
    expect((await callRouter(router, prefix, { path: '/pool/admin' })).status).toBe(503);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/pool/admin/trial-days', body: { days: 0 } })).status).toBe(400);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/pool/admin/instances/x/trial', body: {} })).status).toBe(404);
  });
});

describe('an instance talking to root as itself', () => {
  it('reads and sets whether root tells its owner when it cannot be reached', async () => {
    const { instances, router } = route();
    instances.watchAs.calledWith('inst-1', 'secret').mockResolvedValue(ok({ notifyWhenUnreachable: true, alwaysTold: false }) as never);
    instances.watchAs.calledWith('inst-1', 'wrong').mockResolvedValue(no(401, 'unknown instance or credential'));
    instances.setWatchAs.calledWith('inst-1', 'secret', false).mockResolvedValue(ok({ notifyWhenUnreachable: false, alwaysTold: false }) as never);
    expect((await callRouter(router, prefix, { path: '/watch', headers: asInstance })).body).toEqual({ notifyWhenUnreachable: true, alwaysTold: false });
    expect((await callRouter(router, prefix, { path: '/watch', headers: { ...asInstance, authorization: 'bearer wrong' } })).status).toBe(401);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/watch', headers: asInstance, body: { notifyWhenUnreachable: false } })).body).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
  });

  it('reads no credential from a request that sends none', async () => {
    const { instances, router } = route();
    instances.watchAs.mockResolvedValue(no(401, 'unknown instance or credential'));
    await callRouter(router, prefix, { path: '/watch' });
    expect(instances.watchAs).toHaveBeenCalledWith('', '');
  });

  it('answers its check-in about updates, its release and what it runs', async () => {
    const { instances, router } = route();
    instances.updates.calledWith('inst-1', 'secret').mockResolvedValue(ok({ auto: true }) as never);
    instances.release.calledWith('inst-1', 'secret').mockResolvedValue(ok({ imageTag: 'old111', chartUrl: 'u' }) as never);
    instances.setUpdates.calledWith('inst-1', 'secret', matches<{ version?: unknown }>((change) => change.version === 'v1')).mockResolvedValue(no(409, 'withdrawn'));
    instances.runningOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ running: 'new222' }) as never);
    expect((await callRouter(router, prefix, { path: '/updates', headers: asInstance })).body).toEqual({ auto: true });
    expect((await callRouter(router, prefix, { path: '/release', headers: asInstance })).body).toEqual({ imageTag: 'old111', chartUrl: 'u' });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/updates', headers: asInstance, body: { version: 'v1' } })).status).toBe(409);
    instances.updates.mockResolvedValue(no(401, 'unknown instance or credential'));
    instances.release.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { path: '/updates', headers: asInstance })).status).toBe(401);
    expect((await callRouter(router, prefix, { path: '/release', headers: asInstance })).status).toBe(401);
  });

  it('reports its progress and gets back the status root holds', async () => {
    const { instances, router } = route();
    instances.report.mockResolvedValue(ok({ status: 'ready' }) as never);
    const answer = await callRouter(router, prefix, { method: 'POST', path: '/status', headers: asInstance, body: { status: 'ready', detail: 'Installed' } });
    expect(answer.body).toEqual({ status: 'ready' });
    expect(instances.report).toHaveBeenCalledWith('inst-1', 'secret', { status: 'ready', detail: 'Installed' });
    instances.report.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { method: 'POST', path: '/status', headers: asInstance })).status).toBe(401);
  });

  it('asks for a mesh key for a machine and to take one off, never cached', async () => {
    const { instances, router } = route();
    instances.machineKey.mockResolvedValue(ok({ preAuthKey: 'k' }) as never);
    instances.removeMachineNode.calledWith('inst-1', 'secret', '100.64.0.9').mockResolvedValue(ok({ removed: true }) as never);
    const key = await callRouter(router, prefix, { method: 'POST', path: '/machine-key', headers: asInstance, body: {} });
    expect(key.body).toEqual({ preAuthKey: 'k' });
    expect(key.headers['cache-control']).toBe('no-store');
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/machine-node', headers: asInstance, body: { meshIp: '100.64.0.9' } })).body).toEqual({ removed: true });
    instances.machineKey.mockResolvedValue(no(409, 'not an instance on its own machine'));
    const refused = await callRouter(router, prefix, { method: 'POST', path: '/machine-key', headers: asInstance, body: {} });
    expect([refused.status, refused.headers['cache-control']]).toEqual([409, 'no-store']);
    instances.removeMachineNode.mockResolvedValue(no(404, 'no such node'));
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/machine-node', headers: asInstance })).status).toBe(404);
  });

  it('asks about its trial, its addresses, and names its sign-in key', async () => {
    const { instances, router } = route();
    instances.trialOf.mockResolvedValue(ok({ trialEndsAt: 'x' }) as never);
    instances.addresses.mockResolvedValue(ok({ nested: false }) as never);
    instances.setAddresses.calledWith('inst-1', 'secret', true).mockResolvedValue(ok({ nested: true }) as never);
    instances.announceSignIn.calledWith('inst-1', 'secret', matches<{ kid?: string }>((jwk) => jwk.kid === 'k')).mockResolvedValue(ok({ announced: true }) as never);
    expect((await callRouter(router, prefix, { path: '/trial', headers: asInstance })).body).toEqual({ trialEndsAt: 'x' });
    expect((await callRouter(router, prefix, { path: '/addresses', headers: asInstance })).body).toEqual({ nested: false });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/addresses', headers: asInstance, body: { nested: true } })).body).toEqual({ nested: true });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/sign-in-key', headers: asInstance, body: { jwk: { kid: 'k' } } })).body).toEqual({ announced: true });
    instances.trialOf.mockResolvedValue(no(401, 'x'));
    instances.addresses.mockResolvedValue(no(401, 'x'));
    instances.setAddresses.mockResolvedValue(no(401, 'x'));
    instances.announceSignIn.mockResolvedValue(no(401, 'x'));
    for (const call of [{ path: '/trial' }, { path: '/addresses' }, { method: 'PUT' as const, path: '/addresses', body: {} }, { method: 'PUT' as const, path: '/sign-in-key', body: {} }]) {
      expect((await callRouter(router, prefix, { ...call, headers: asInstance })).status).toBe(401);
    }
  });

  it('checks, claims and frees a group', async () => {
    const { instances, router } = route();
    instances.checkGroup.calledWith('inst-1', 'secret', 'acme').mockResolvedValue(ok({ ok: true }) as never);
    instances.claimGroup.calledWith('inst-1', 'secret', 'p1', 'acme').mockResolvedValue(ok({ projectId: 'p1', name: 'acme' }) as never);
    instances.claimGroup.calledWith('inst-1', 'secret', 'p2', 'acme').mockResolvedValue(no(409, '"acme" is taken'));
    instances.releaseGroup.calledWith('inst-1', 'secret', 'p1').mockResolvedValue(ok({ released: true }) as never);
    expect((await callRouter(router, prefix, { path: '/groups/check?name=acme', headers: asInstance })).body).toEqual({ ok: true });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/groups', headers: asInstance, body: { projectId: 'p1', name: 'acme' } })).body).toEqual({ projectId: 'p1', name: 'acme' });
    const taken = await callRouter(router, prefix, { method: 'PUT', path: '/groups', headers: asInstance, body: { projectId: 'p2', name: 'acme' } });
    expect([taken.status, taken.body]).toEqual([409, { error: '"acme" is taken' }]);
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/groups/p1', headers: asInstance })).body).toEqual({ released: true });
  });
});

describe('how an instance joins', () => {
  it('hands the bundle as JSON, or as the installer\'s shell-safe text, never cached', async () => {
    const { instances, router } = route();
    instances.join.calledWith('tok', 'box').mockResolvedValue(ok(bundle));
    const json = await callRouter(router, prefix, { method: 'POST', path: '/join', body: { token: 'tok', machine: 'box' } });
    expect(json.body).toMatchObject({ instanceId: 'inst-1', credential: bundle.credential });
    expect(json.headers['cache-control']).toBe('no-store');
    const text = await callRouter(router, prefix, { method: 'POST', path: '/join?format=env', body: { token: 'tok', machine: 'box' } });
    expect(text.headers['content-type']).toContain('text/plain');
    expect(text.text).toBe(bundleAsEnv(bundle));
  });

  it('refuses a token that does not work, still never cached', async () => {
    const { instances, router } = route();
    instances.join.mockResolvedValue(no(401, 'that token is not valid'));
    const refused = await callRouter(router, prefix, { method: 'POST', path: '/join', body: { token: 'bad' } });
    expect([refused.status, refused.body, refused.headers['cache-control']]).toEqual([401, { error: 'that token is not valid' }, 'no-store']);
  });
});

describe('the chart root serves', () => {
  it('serves the chart it packaged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chart-'));
    writeFileSync(join(dir, 'chart.tgz'), 'the chart');
    const { router } = route({ chart: async () => join(dir, 'chart.tgz') });
    const answer = await callRouter(router, prefix, { path: '/chart.tgz' });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('application/gzip');
    expect(answer.text).toBe('the chart');
  });

  it('serves the chart of a release it kept, and says so when it keeps none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chart-'));
    writeFileSync(join(dir, 'old111.tgz'), 'old chart');
    const { router } = route({ chartOf: (tag) => (tag === 'old111' ? join(dir, 'old111.tgz') : undefined) });
    expect((await callRouter(router, prefix, { path: '/chart/old111.tgz' })).text).toBe('old chart');
    const missing = await callRouter(router, prefix, { path: '/chart/nothing.tgz' });
    expect([missing.status, missing.body]).toEqual([404, { error: 'root keeps no chart for that release' }]);
    expect((await callRouter(router, prefix, { path: '/chart/old111' })).status).toBe(404);
    expect((await callRouter(instancesRouter({ instances: mock<Instances>(), chart: async () => '' }), prefix, { path: '/chart/old111.tgz' })).status).toBe(404);
  });
});

describe('Koala\'s dependencies on root', () => {
  const watch = () => {
    const dependencies = mock<Pick<DependencyWatch, 'view' | 'check' | 'forRelease'>>();
    dependencies.view.mockResolvedValue({ findings: [], check: undefined });
    dependencies.check.mockResolvedValue({ findings: [] });
    dependencies.forRelease.calledWith('new222').mockResolvedValue({ release: 'v2026.10.25', findings: [] });
    return dependencies;
  };

  it('shows the findings and runs the check only for who administers', async () => {
    const dependencies = watch();
    const refused = route({ administers: refuse, dependencies });
    expect((await callRouter(refused.router, prefix, { path: '/dependencies' })).status).toBe(403);
    expect((await callRouter(refused.router, prefix, { method: 'POST', path: '/dependencies/check' })).status).toBe(403);
    const { router } = route({ administers: allow, dependencies });
    const seen = await callRouter(router, prefix, { path: '/dependencies' });
    expect([seen.status, seen.headers['cache-control']]).toEqual([200, 'no-store']);
    expect((await callRouter(router, prefix, { method: 'POST', path: '/dependencies/check' })).body).toEqual({ findings: [] });
  });

  it('falls back to the pool\'s operator check when nobody is named to administer', async () => {
    const { router } = route({ dependencies: watch() });
    expect((await callRouter(router, prefix, { path: '/dependencies' })).status).toBe(403);
  });

  it('says so where it keeps no record, and when a check cannot finish', async () => {
    const none = route({ administers: allow });
    expect((await callRouter(none.router, prefix, { path: '/dependencies' })).status).toBe(404);
    expect((await callRouter(none.router, prefix, { method: 'POST', path: '/dependencies/check' })).status).toBe(404);
    const dependencies = watch();
    dependencies.check.mockRejectedValue(new Error('OSV answered 503'));
    const failing = await callRouter(route({ administers: allow, dependencies }).router, prefix, { method: 'POST', path: '/dependencies/check' });
    expect([failing.status, failing.body]).toEqual([502, { error: 'the check could not finish: OSV answered 503' }]);
  });

  it('tells an instance what the release it runs carries', async () => {
    const { instances, router } = route({ dependencies: watch() });
    instances.runningOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ running: 'new222' }) as never);
    expect((await callRouter(router, prefix, { path: '/release-findings', headers: asInstance })).body).toEqual({ release: 'v2026.10.25', findings: [] });
    instances.runningOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ running: undefined }) as never);
    expect((await callRouter(router, prefix, { path: '/release-findings', headers: asInstance })).body).toEqual({ findings: [] });
    instances.runningOf.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { path: '/release-findings', headers: asInstance })).status).toBe(401);
  });

  it('gives an empty list where it keeps no record of dependencies', async () => {
    const { instances, router } = route();
    instances.runningOf.mockResolvedValue(ok({ running: 'new222' }) as never);
    expect((await callRouter(router, prefix, { path: '/release-findings', headers: asInstance })).body).toEqual({ findings: [] });
  });
});

describe('root\'s mail on its admin page', () => {
  it('shows what root found about its mail and checks again on asking, only for who administers', async () => {
    const mailReputation = mock<Pick<MailReputation, 'view' | 'check'>>();
    mailReputation.view.mockReturnValue({ checking: false } as never);
    mailReputation.check.mockResolvedValue(undefined as never);
    const refused = route({ administers: refuse, mailReputation });
    expect((await callRouter(refused.router, prefix, { path: '/mail-reputation' })).status).toBe(403);
    expect(mailReputation.view).not.toHaveBeenCalled();
    const { router } = route({ administers: allow, mailReputation });
    const seen = await callRouter(router, prefix, { path: '/mail-reputation' });
    expect([seen.body, seen.headers['cache-control']]).toEqual([{ checking: false }, 'no-store']);
    const started = await callRouter(router, prefix, { method: 'POST', path: '/mail-reputation/check' });
    expect([started.status, started.body]).toEqual([202, { checking: false }]);
    expect(mailReputation.check).toHaveBeenCalledTimes(1);
  });

  it('logs a check that could not finish rather than failing the request', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mailReputation = mock<Pick<MailReputation, 'view' | 'check'>>();
      mailReputation.view.mockReturnValue({ checking: true } as never);
      mailReputation.check.mockRejectedValue(new Error('no resolver'));
      const started = await callRouter(route({ administers: allow, mailReputation }).router, prefix, { method: 'POST', path: '/mail-reputation/check' });
      expect(started.status).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('no resolver'));
    } finally {
      warned.mockRestore();
    }
  });

  it('says so where this server sends no mail itself', async () => {
    const { router } = route({ administers: allow });
    expect((await callRouter(router, prefix, { path: '/mail-reputation' })).status).toBe(404);
    expect((await callRouter(router, prefix, { method: 'POST', path: '/mail-reputation/check' })).status).toBe(404);
  });
});

describe('an instance sending mail through root', () => {
  const mailing = (verdict?: ReturnType<InstanceMailLimit['take']>) => {
    const instances = mock<Instances>();
    const mail = mock<Pick<MailService, 'toOwner'>>();
    const mailLimit = verdict ? mock<InstanceMailLimit>({ take: () => verdict }) : undefined;
    const router = instancesRouter({ instances, chart: async () => '', mail, ...(mailLimit ? { mailLimit } : {}) });
    instances.ownerOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ ownerId: 'owner-1' }) as never);
    return { instances, mail, router };
  };
  const send = (router: ReturnType<typeof mailing>['router'], body: unknown) => callRouter(router, prefix, { method: 'POST', path: '/mail', headers: asInstance, body });

  it('sends only to the instance\'s owner, in one line and a text', async () => {
    const { mail, router } = mailing();
    mail.toOwner.mockResolvedValue(undefined);
    const answer = await send(router, { subject: 'Alert', text: 'Something fired' });
    expect(answer.body).toEqual({ sent: true });
    expect(mail.toOwner).toHaveBeenCalledWith('owner-1', { subject: 'Alert', text: 'Something fired' });
  });

  it('refuses a subject or text that is not mail, before sending', async () => {
    const { mail, router } = mailing();
    expect((await send(router, { subject: 'two\nlines', text: 'x' })).status).toBe(400);
    expect((await send(router, { subject: 'ok' })).status).toBe(400);
    expect(mail.toOwner).not.toHaveBeenCalled();
  });

  it('refuses an instance root does not know', async () => {
    const { instances, router } = mailing();
    instances.ownerOf.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await send(router, { subject: 'a', text: 'b' })).status).toBe(401);
  });

  it('says so where root sends no email', async () => {
    const { instances } = route();
    instances.ownerOf.mockResolvedValue(ok({ ownerId: 'owner-1' }) as never);
    const answer = await send(instancesRouter({ instances, chart: async () => '' }), { subject: 'a', text: 'b' });
    expect([answer.status, answer.body]).toEqual([503, { error: 'this root sends no email' }]);
  });

  it('holds mail back past the hourly allowance, telling the owner once', async () => {
    const until = Date.parse('2026-11-02T13:00:00.000Z');
    const { mail, router } = mailing({ send: false, tell: true, until, window: { sent: [] } });
    mail.toOwner.mockResolvedValue(undefined);
    const held = await send(router, { subject: 'a', text: 'b' });
    expect([held.status, held.body]).toEqual([429, { error: 'this instance has sent as many emails as an hour allows; more are held back until 2026-11-02T13:00:00.000Z' }]);
    expect(mail.toOwner).toHaveBeenCalledTimes(1);
    expect(mail.toOwner).toHaveBeenCalledWith('owner-1', expect.objectContaining({ subject: 'Koala is holding back email from your instance' }));
  });

  it('holds mail back without telling the owner again, or when they cannot be told', async () => {
    const until = Date.parse('2026-11-02T13:00:00.000Z');
    const quiet = mailing({ send: false, tell: false, until, window: { sent: [] } });
    expect((await send(quiet.router, { subject: 'a', text: 'b' })).status).toBe(429);
    expect(quiet.mail.toOwner).not.toHaveBeenCalled();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failing = mailing({ send: false, tell: true, until, window: { sent: [] } });
      failing.mail.toOwner.mockRejectedValue(new Error('mail is off'));
      expect((await send(failing.router, { subject: 'a', text: 'b' })).status).toBe(429);
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('mail is off'));
    } finally {
      warned.mockRestore();
    }
  });

  it('sends while the allowance lasts', async () => {
    const { mail, router } = mailing({ send: true, window: { sent: [1] } });
    mail.toOwner.mockResolvedValue(undefined);
    expect((await send(router, { subject: 'a', text: 'b' })).body).toEqual({ sent: true });
  });

  it('passes on what the mailer says, and calls any other failure a bad gateway', async () => {
    const { mail, router } = mailing();
    mail.toOwner.mockRejectedValueOnce(new MailError(422, 'that address does not take mail'));
    const refused = await send(router, { subject: 'a', text: 'b' });
    expect([refused.status, refused.body]).toEqual([422, { error: 'that address does not take mail' }]);
    mail.toOwner.mockRejectedValueOnce(new Error('connection reset'));
    const failed = await send(router, { subject: 'a', text: 'b' });
    expect([failed.status, failed.body]).toEqual([502, { error: 'it could not be sent: connection reset' }]);
  });
});

describe('a hub asking root for access on an instance\'s behalf', () => {
  it('gives the access root grants the instance\'s owner', async () => {
    const hubAccess = vi.fn(async (_instanceId: string, ownerId: string) => ({ token: `for-${ownerId}` }) as never);
    const { instances, router } = route({ hubAccess });
    instances.ownerOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ ownerId: 'owner-1' }) as never);
    expect((await callRouter(router, prefix, { method: 'POST', path: '/hub-token', headers: asInstance })).body).toEqual({ token: 'for-owner-1' });
    expect(hubAccess).toHaveBeenCalledWith('inst-1', 'owner-1');
  });

  it('says there is no hub where root has none, and refuses an instance it does not know', async () => {
    const { instances, router } = route();
    instances.ownerOf.mockResolvedValueOnce(ok({ ownerId: 'owner-1' }) as never);
    const none = await callRouter(router, prefix, { method: 'POST', path: '/hub-token', headers: asInstance });
    expect([none.status, none.body]).toEqual([404, { error: 'this root has no hub' }]);
    instances.ownerOf.mockResolvedValueOnce(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { method: 'POST', path: '/hub-token', headers: asInstance })).status).toBe(401);
  });
});

describe('moving a pool instance to its owner\'s machine', () => {
  it('starts, reads and stops the move for the person', async () => {
    const { instances, router } = route();
    instances.startMove.calledWith(PERSON.id).mockResolvedValue(ok({ command: 'curl ...' }) as never);
    instances.moveOf.calledWith(PERSON.id).mockResolvedValue({ state: 'copying' } as never);
    instances.stopMove.calledWith(PERSON.id).mockResolvedValue(no(409, 'nothing is moving'));
    expect((await callRouter(router, prefix, { method: 'POST', path: '/move' })).body).toEqual({ command: 'curl ...' });
    expect((await callRouter(router, prefix, { path: '/move' })).body).toEqual({ move: { state: 'copying' } });
    const stopped = await callRouter(router, prefix, { method: 'DELETE', path: '/move' });
    expect([stopped.status, stopped.body]).toEqual([409, { error: 'nothing is moving' }]);
  });

  it('starts, reads and stops it for an instance asking as itself', async () => {
    const { instances, router } = route();
    instances.startMoveAs.calledWith('inst-1', 'secret').mockResolvedValue(ok({ command: 'curl ...' }) as never);
    instances.moveOfAs.calledWith('inst-1', 'secret').mockResolvedValue(ok({ state: 'joined' }) as never);
    instances.stopMoveAs.calledWith('inst-1', 'secret').mockResolvedValue(ok({ stopping: true }) as never);
    expect((await callRouter(router, prefix, { method: 'POST', path: '/move/self', headers: asInstance })).body).toEqual({ command: 'curl ...' });
    expect((await callRouter(router, prefix, { path: '/move/self', headers: asInstance })).body).toEqual({ move: { state: 'joined' } });
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/move/self', headers: asInstance })).body).toEqual({ stopping: true });
    instances.moveOfAs.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { path: '/move/self', headers: asInstance })).status).toBe(401);
  });
});

describe('the new machine reading a moving instance through root', () => {
  const upstream = (status: number | undefined, body: string, headers: Record<string, string> = {}) =>
    Object.assign(Readable.from([body]), { statusCode: status, headers }) as unknown as IncomingMessage;

  it('streams each part from the pool instance to the move\'s own credential', async () => {
    const moveRelay = mock<MoveRelay>();
    const { instances, router } = route({ moveRelay });
    instances.moveSource.calledWith('inst-1', 'secret').mockResolvedValue(ok({ name: 'alice', instanceId: 'inst-1' }) as never);
    moveRelay.open.calledWith(matches<{ name: string }>((source) => source.name === 'alice'), 'mongo').mockResolvedValue(upstream(200, 'the mongo of alice', { 'content-type': 'application/gzip' }));
    const answer = await callRouter(router, prefix, { path: '/move/parts/mongo', headers: asInstance });
    expect([answer.status, answer.text, answer.headers['content-type'], answer.headers['cache-control']]).toEqual([200, 'the mongo of alice', 'application/gzip', 'no-store']);
  });

  it('streams a volume, and answers what the pool instance answered', async () => {
    const moveRelay = mock<MoveRelay>();
    const { instances, router } = route({ moveRelay });
    instances.moveSource.mockResolvedValue(ok({ name: 'alice', instanceId: 'inst-1' }) as never);
    moveRelay.open.mockResolvedValue(upstream(409, '{"error":"work is running"}'));
    const answer = await callRouter(router, prefix, { path: '/move/parts/volume:books:data-web-0', headers: asInstance });
    expect([answer.status, answer.text]).toEqual([409, '{"error":"work is running"}']);
    expect(moveRelay.open).toHaveBeenCalledWith(expect.anything(), 'volume:books:data-web-0');
  });

  it('calls it a bad gateway when the pool instance said no status', async () => {
    const moveRelay = mock<MoveRelay>();
    const { instances, router } = route({ moveRelay });
    instances.moveSource.mockResolvedValue(ok({ name: 'alice', instanceId: 'inst-1' }) as never);
    moveRelay.open.mockResolvedValue(upstream(undefined, ''));
    expect((await callRouter(router, prefix, { path: '/move/parts/mongo', headers: asInstance })).status).toBe(502);
  });

  it('says so when it is not a part, when the credential is wrong, when root moves nothing, and when the pool cannot be reached', async () => {
    const moveRelay = mock<MoveRelay>();
    const { instances, router } = route({ moveRelay });
    expect((await callRouter(router, prefix, { path: '/move/parts/everything', headers: asInstance })).status).toBe(404);
    instances.moveSource.mockResolvedValueOnce(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { path: '/move/parts/mongo', headers: asInstance })).status).toBe(401);
    instances.moveSource.mockResolvedValue(ok({ name: 'alice', instanceId: 'inst-1' }) as never);
    moveRelay.open.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const down = await callRouter(router, prefix, { path: '/move/parts/mongo', headers: asInstance });
    expect([down.status, down.body]).toEqual([502, { error: 'Koala\'s servers could not be reached: connect ECONNREFUSED' }]);
    const bare = route();
    bare.instances.moveSource.mockResolvedValue(ok({ name: 'alice', instanceId: 'inst-1' }) as never);
    const nothing = await callRouter(bare.router, prefix, { path: '/move/parts/mongo', headers: asInstance });
    expect([nothing.status, nothing.body]).toEqual([503, { error: 'this root moves no instances' }]);
  });
});

describe('a pool instance asking root about its own apps', () => {
  const place = { name: 'alice', hostNamespace: 'pool-alice' };
  const watching = () => {
    const poolMonitoring = mock<PoolMonitoringService>();
    const { instances, router } = route({ poolMonitoring });
    instances.poolPlaceOf.calledWith('inst-1', 'secret').mockResolvedValue(ok(place) as never);
    return { poolMonitoring, instances, router };
  };

  it('answers only a named question about the instance\'s own place', async () => {
    const { poolMonitoring, router } = watching();
    poolMonitoring.ask.mockResolvedValue([{ metric: {}, value: 1 }]);
    const answer = await callRouter(router, prefix, { method: 'POST', path: '/monitoring/ask', headers: asInstance, body: { ask: { kind: 'app', question: 'up', subject: { namespace: 'shop' } } } });
    expect(answer.body).toEqual({ samples: [{ metric: {}, value: 1 }] });
    expect(poolMonitoring.ask).toHaveBeenCalledWith(expect.objectContaining({ hostNamespace: 'pool-alice' }), { kind: 'app', question: 'up', subject: { namespace: 'shop' } });
    const raw = await callRouter(router, prefix, { method: 'POST', path: '/monitoring/ask', headers: asInstance, body: { ask: { kind: 'query', query: 'up' } } });
    expect([raw.status, raw.body]).toEqual([400, { error: 'that is not a question Koala answers' }]);
  });

  it('answers a question over a time range, and refuses a range it does not answer', async () => {
    const { poolMonitoring, router } = watching();
    poolMonitoring.askRange.mockResolvedValue([[1, 2]]);
    const ask = { kind: 'app', question: 'up', subject: { namespace: 'shop' } };
    const answer = await callRouter(router, prefix, { method: 'POST', path: '/monitoring/ask', headers: asInstance, body: { ask, range: { start: 0, end: 600, step: 60 } } });
    expect(answer.body).toEqual({ points: [[1, 2]] });
    const bad = await callRouter(router, prefix, { method: 'POST', path: '/monitoring/ask', headers: asInstance, body: { ask, range: { start: 10, end: 5, step: 60 } } });
    expect([bad.status, bad.body]).toEqual([400, { error: 'that is not a time range Koala answers for' }]);
  });

  it('turns away an instance it does not know, and says when root watches no pool', async () => {
    const { instances, router } = watching();
    instances.poolPlaceOf.calledWith('inst-1', 'wrong').mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await callRouter(router, prefix, { path: '/monitoring', headers: { ...asInstance, authorization: 'Bearer wrong' } })).status).toBe(401);
    const bare = route();
    bare.instances.poolPlaceOf.mockResolvedValue(ok(place) as never);
    const none = await callRouter(bare.router, prefix, { path: '/monitoring', headers: asInstance });
    expect([none.status, none.body]).toEqual([503, { error: 'this root watches no pool' }]);
  });

  it('shows how long history is kept, and its alerts', async () => {
    const { poolMonitoring, router } = watching();
    poolMonitoring.history.mockReturnValue({ days: 10, kept: 10 });
    poolMonitoring.alerts.mockResolvedValue([{ labels: { alertname: 'x' } }] as never);
    expect((await callRouter(router, prefix, { path: '/monitoring', headers: asInstance })).body).toEqual({ days: 10, kept: 10 });
    expect((await callRouter(router, prefix, { path: '/monitoring/alerts', headers: asInstance })).body).toEqual({ alerts: [{ labels: { alertname: 'x' } }] });
  });

  it('sets the probes the instance wants, and refuses ones that are not probes', async () => {
    const { poolMonitoring, router } = watching();
    poolMonitoring.setProbes.mockResolvedValue({ probed: 1, missing: [] });
    const probes = [{ namespace: 'shop', service: 'web', port: 80, path: '', module: 'http_2xx' }];
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/monitoring/probes', headers: asInstance, body: { probes } })).body).toEqual({ probed: 1, missing: [] });
    expect(poolMonitoring.setProbes).toHaveBeenCalledWith('alice', expect.objectContaining({ hostNamespace: 'pool-alice' }), probes);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/monitoring/probes', headers: asInstance, body: { probes: 'all' } })).status).toBe(400);
  });

  it('sets and removes an alert, and refuses one it cannot set', async () => {
    const { poolMonitoring, router } = watching();
    poolMonitoring.setRule.mockResolvedValue(undefined);
    poolMonitoring.removeRule.mockResolvedValue(undefined);
    const set = await callRouter(router, prefix, { method: 'PUT', path: '/monitoring/rules/r1', headers: asInstance, body: { namespace: 'shop', spec: { kind: 'down' }, summary: 'Shop is down' } });
    expect(set.body).toEqual({ set: 'r1' });
    const bad = await callRouter(router, prefix, { method: 'PUT', path: '/monitoring/rules/r1', headers: asInstance, body: { namespace: 'shop', spec: { kind: 'nonsense' }, summary: 's' } });
    expect(bad.status).toBe(400);
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/monitoring/rules/r1', headers: asInstance })).body).toEqual({ removed: true });
    expect(poolMonitoring.removeRule).toHaveBeenCalledWith(expect.objectContaining({ hostNamespace: 'pool-alice' }), 'r1');
  });

  it('says what the pool node refused, and calls anything else a bad gateway with its first line', async () => {
    const { poolMonitoring, router } = watching();
    poolMonitoring.alerts.mockRejectedValueOnce(new PoolMonitoringError(400, 'that alert cannot be measured here'));
    poolMonitoring.alerts.mockRejectedValueOnce(new Error('Prometheus is down\nsecond line'));
    poolMonitoring.setRule.mockRejectedValueOnce(new PoolMonitoringError(400, 'errors are not measured'));
    poolMonitoring.removeRule.mockRejectedValueOnce(new Error('kubectl failed'));
    poolMonitoring.setProbes.mockRejectedValueOnce(new Error('kubectl failed'));
    poolMonitoring.ask.mockRejectedValueOnce(new Error('kubectl failed'));
    const refused = await callRouter(router, prefix, { path: '/monitoring/alerts', headers: asInstance });
    expect([refused.status, refused.body]).toEqual([400, { error: 'that alert cannot be measured here' }]);
    const down = await callRouter(router, prefix, { path: '/monitoring/alerts', headers: asInstance });
    expect([down.status, down.body]).toEqual([502, { error: 'Koala\'s servers could not answer: Prometheus is down' }]);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/monitoring/rules/r1', headers: asInstance, body: { namespace: 'shop', spec: { kind: 'down' }, summary: 'x' } })).status).toBe(400);
    expect((await callRouter(router, prefix, { method: 'DELETE', path: '/monitoring/rules/r1', headers: asInstance })).status).toBe(502);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/monitoring/probes', headers: asInstance, body: { probes: [] } })).status).toBe(502);
    expect((await callRouter(router, prefix, { method: 'POST', path: '/monitoring/ask', headers: asInstance, body: { ask: { kind: 'cluster', question: 'nodes' } } })).status).toBe(502);
  });
});

