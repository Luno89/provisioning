import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { MailError, type MailReputation, type MailService } from '../../platform/index.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { Router } from 'express';
import { instancesRouter } from './instances.js';
import type { Outcome } from '../services/InstanceService.js';
import type { DependencyWatch } from '../services/DependencyWatch.js';
import type { InstanceMailLimit } from '../services/InstanceMailLimit.js';

type Instances = Parameters<typeof instancesRouter>[0]['instances'];

const prefix = '/api/instances';
const on = (router: Router) => routesInProcess({ prefix, router: () => router, user: PERSON });
const asInstance = { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' };
const ok = <T,>(value: T): Outcome<T> => ({ ok: true, value });
const no = (status: 400 | 401 | 404 | 409 | 503, error: string): Outcome<never> => ({ ok: false, status, error });
const allow: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => next();
const refuse: RequestHandler = (_req: Request, res: Response) => { res.status(403).json({ error: 'Only the operator of this server can do that.' }); };

const route = (deps: Partial<Parameters<typeof instancesRouter>[0]> = {}) => {
  const instances = mock<Instances>();
  return { instances, router: instancesRouter({ instances, chart: async () => '', ...deps }) };
};

describe('a person making their instance', () => {
  it('checks a name, and passes on what the query asked', async () => {
    const { instances, router } = route();
    instances.nameCheck.calledWith(PERSON.id, 'luno').mockResolvedValue({ ok: true } as never);
    expect((await (await on(router)).get(`${prefix}/name-check?name=luno`)).data).toEqual({ ok: true });
  });

  it('shows their instance and switches whether root emails them when it is unreachable', async () => {
    const { instances, router } = route();
    instances.mine.calledWith(PERSON.id).mockResolvedValue({ id: 'inst-1' } as never);
    instances.setWatchOf.calledWith(PERSON.id, false).mockResolvedValue(ok({ notifyWhenUnreachable: false }) as never);
    instances.setWatchOf.calledWith(PERSON.id, 'no').mockResolvedValue(no(400, 'send true or false'));
    expect((await (await on(router)).get(`${prefix}/mine`)).data).toEqual({ instance: { id: 'inst-1' } });
    expect((await (await on(router)).put(`${prefix}/mine/watch`, { notifyWhenUnreachable: false })).data).toEqual({ notifyWhenUnreachable: false });
    expect((await (await on(router)).put(`${prefix}/mine/watch`, { notifyWhenUnreachable: 'no' })).status).toBe(400);
  });
});

describe('an instance talking to root as itself', () => {
  it('reads and sets whether root tells its owner when it cannot be reached', async () => {
    const { instances, router } = route();
    instances.watchAs.calledWith('inst-1', 'secret').mockResolvedValue(ok({ notifyWhenUnreachable: true }) as never);
    instances.watchAs.calledWith('inst-1', 'wrong').mockResolvedValue(no(401, 'unknown instance or credential'));
    instances.setWatchAs.calledWith('inst-1', 'secret', false).mockResolvedValue(ok({ notifyWhenUnreachable: false }) as never);
    expect((await (await on(router)).get(`${prefix}/watch`, { headers: asInstance })).data).toEqual({ notifyWhenUnreachable: true });
    expect((await (await on(router)).get(`${prefix}/watch`, { headers: { ...asInstance, authorization: 'bearer wrong' } })).status).toBe(401);
    expect((await (await on(router)).put(`${prefix}/watch`, { notifyWhenUnreachable: false }, { headers: asInstance })).data).toEqual({ notifyWhenUnreachable: false });
  });

  it('reads no credential from a request that sends none', async () => {
    const { instances, router } = route();
    instances.watchAs.mockResolvedValue(no(401, 'unknown instance or credential'));
    await (await on(router)).get(`${prefix}/watch`);
    expect(instances.watchAs).toHaveBeenCalledWith('', '');
  });

  it('answers its check-in about updates, its release and what it runs', async () => {
    const { instances, router } = route();
    instances.updates.calledWith('inst-1', 'secret').mockResolvedValue(ok({ auto: true }) as never);
    instances.release.calledWith('inst-1', 'secret').mockResolvedValue(ok({ imageTag: 'old111', chartUrl: 'u' }) as never);
    instances.setUpdates.calledWith('inst-1', 'secret', matches<{ version?: unknown }>((change) => change.version === 'v1')).mockResolvedValue(no(409, 'withdrawn'));
    instances.runningOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ running: 'new222' }) as never);
    expect((await (await on(router)).get(`${prefix}/updates`, { headers: asInstance })).data).toEqual({ auto: true });
    expect((await (await on(router)).get(`${prefix}/release`, { headers: asInstance })).data).toEqual({ imageTag: 'old111', chartUrl: 'u' });
    expect((await (await on(router)).put(`${prefix}/updates`, { version: 'v1' }, { headers: asInstance })).status).toBe(409);
    instances.updates.mockResolvedValue(no(401, 'unknown instance or credential'));
    instances.release.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await (await on(router)).get(`${prefix}/updates`, { headers: asInstance })).status).toBe(401);
    expect((await (await on(router)).get(`${prefix}/release`, { headers: asInstance })).status).toBe(401);
  });

  it('reports its progress and gets back the status root holds', async () => {
    const { instances, router } = route();
    instances.report.mockResolvedValue(ok({ status: 'ready' }) as never);
    const answer = await (await on(router)).post(`${prefix}/status`, { status: 'ready', detail: 'Installed' }, { headers: asInstance });
    expect(answer.data).toEqual({ status: 'ready' });
    expect(instances.report).toHaveBeenCalledWith('inst-1', 'secret', { status: 'ready', detail: 'Installed' });
    instances.report.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await (await on(router)).post(`${prefix}/status`, undefined, { headers: asInstance })).status).toBe(401);
  });

  it('asks about its addresses', async () => {
    const { instances, router } = route();
    instances.addresses.mockResolvedValue(ok({ nested: false }) as never);
    instances.setAddresses.calledWith('inst-1', 'secret', true).mockResolvedValue(ok({ nested: true }) as never);
    expect((await (await on(router)).get(`${prefix}/addresses`, { headers: asInstance })).data).toEqual({ nested: false });
    expect((await (await on(router)).put(`${prefix}/addresses`, { nested: true }, { headers: asInstance })).data).toEqual({ nested: true });
    instances.addresses.mockResolvedValue(no(401, 'x'));
    instances.setAddresses.mockResolvedValue(no(401, 'x'));
    for (const call of [{ path: '/addresses' }, { method: 'PUT' as const, path: '/addresses', body: {} }]) {
      expect((await (await on(router)).request(call.method ?? 'GET', `${prefix}${call.path}`, { body: call.body, headers: asInstance })).status).toBe(401);
    }
  });

  it('checks, claims and frees a group', async () => {
    const { instances, router } = route();
    instances.checkGroup.calledWith('inst-1', 'secret', 'acme').mockResolvedValue(ok({ ok: true }) as never);
    instances.claimGroup.calledWith('inst-1', 'secret', 'p1', 'acme').mockResolvedValue(ok({ projectId: 'p1', name: 'acme' }) as never);
    instances.claimGroup.calledWith('inst-1', 'secret', 'p2', 'acme').mockResolvedValue(no(409, '"acme" is taken'));
    instances.releaseGroup.calledWith('inst-1', 'secret', 'p1').mockResolvedValue(ok({ released: true }) as never);
    expect((await (await on(router)).get(`${prefix}/groups/check?name=acme`, { headers: asInstance })).data).toEqual({ ok: true });
    expect((await (await on(router)).put(`${prefix}/groups`, { projectId: 'p1', name: 'acme' }, { headers: asInstance })).data).toEqual({ projectId: 'p1', name: 'acme' });
    const taken = await (await on(router)).put(`${prefix}/groups`, { projectId: 'p2', name: 'acme' }, { headers: asInstance });
    expect([taken.status, taken.data]).toEqual([409, { error: '"acme" is taken' }]);
    expect((await (await on(router)).delete(`${prefix}/groups/p1`, { headers: asInstance })).data).toEqual({ released: true });
  });
});

describe('the chart root serves', () => {
  it('serves the chart it packaged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chart-'));
    writeFileSync(join(dir, 'chart.tgz'), 'the chart');
    const { router } = route({ chart: async () => join(dir, 'chart.tgz') });
    const answer = await (await on(router)).get(`${prefix}/chart.tgz`);
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('application/gzip');
    expect(answer.text).toBe('the chart');
  });

  it('serves the chart of a release it kept, and says so when it keeps none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chart-'));
    writeFileSync(join(dir, 'old111.tgz'), 'old chart');
    const { router } = route({ chartOf: (tag) => (tag === 'old111' ? join(dir, 'old111.tgz') : undefined) });
    expect((await (await on(router)).get(`${prefix}/chart/old111.tgz`)).text).toBe('old chart');
    const missing = await (await on(router)).get(`${prefix}/chart/nothing.tgz`);
    expect([missing.status, missing.data]).toEqual([404, { error: 'root keeps no chart for that release' }]);
    expect((await (await on(router)).get(`${prefix}/chart/old111`)).status).toBe(404);
    expect((await (await on(instancesRouter({ instances: mock<Instances>(), chart: async () => '' }))).get(`${prefix}/chart/old111.tgz`)).status).toBe(404);
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
    expect((await (await on(refused.router)).get(`${prefix}/dependencies`)).status).toBe(403);
    expect((await (await on(refused.router)).post(`${prefix}/dependencies/check`)).status).toBe(403);
    const { router } = route({ administers: allow, dependencies });
    const seen = await (await on(router)).get(`${prefix}/dependencies`);
    expect([seen.status, seen.headers['cache-control']]).toEqual([200, 'no-store']);
    expect((await (await on(router)).post(`${prefix}/dependencies/check`)).data).toEqual({ findings: [] });
  });

  it('falls back to the operator check when nobody is named to administer', async () => {
    const { router } = route({ dependencies: watch() });
    expect((await (await on(router)).get(`${prefix}/dependencies`)).status).toBe(403);
  });

  it('says so where it keeps no record, and when a check cannot finish', async () => {
    const none = route({ administers: allow });
    expect((await (await on(none.router)).get(`${prefix}/dependencies`)).status).toBe(404);
    expect((await (await on(none.router)).post(`${prefix}/dependencies/check`)).status).toBe(404);
    const dependencies = watch();
    dependencies.check.mockRejectedValue(new Error('OSV answered 503'));
    const failing = await (await on(route({ administers: allow, dependencies }).router)).post(`${prefix}/dependencies/check`);
    expect([failing.status, failing.data]).toEqual([502, { error: 'the check could not finish: OSV answered 503' }]);
  });

  it('tells an instance what the release it runs carries', async () => {
    const { instances, router } = route({ dependencies: watch() });
    instances.runningOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ running: 'new222' }) as never);
    expect((await (await on(router)).get(`${prefix}/release-findings`, { headers: asInstance })).data).toEqual({ release: 'v2026.10.25', findings: [] });
    instances.runningOf.calledWith('inst-1', 'secret').mockResolvedValue(ok({ running: undefined }) as never);
    expect((await (await on(router)).get(`${prefix}/release-findings`, { headers: asInstance })).data).toEqual({ findings: [] });
    instances.runningOf.mockResolvedValue(no(401, 'unknown instance or credential'));
    expect((await (await on(router)).get(`${prefix}/release-findings`, { headers: asInstance })).status).toBe(401);
  });

  it('gives an empty list where it keeps no record of dependencies', async () => {
    const { instances, router } = route();
    instances.runningOf.mockResolvedValue(ok({ running: 'new222' }) as never);
    expect((await (await on(router)).get(`${prefix}/release-findings`, { headers: asInstance })).data).toEqual({ findings: [] });
  });
});

describe('root\'s mail on its admin page', () => {
  it('shows what root found about its mail and checks again on asking, only for who administers', async () => {
    const mailReputation = mock<Pick<MailReputation, 'view' | 'check'>>();
    mailReputation.view.mockReturnValue({ checking: false } as never);
    mailReputation.check.mockResolvedValue(undefined as never);
    const refused = route({ administers: refuse, mailReputation });
    expect((await (await on(refused.router)).get(`${prefix}/mail-reputation`)).status).toBe(403);
    expect(mailReputation.view).not.toHaveBeenCalled();
    const { router } = route({ administers: allow, mailReputation });
    const seen = await (await on(router)).get(`${prefix}/mail-reputation`);
    expect([seen.data, seen.headers['cache-control']]).toEqual([{ checking: false }, 'no-store']);
    const started = await (await on(router)).post(`${prefix}/mail-reputation/check`);
    expect([started.status, started.data]).toEqual([202, { checking: false }]);
    expect(mailReputation.check).toHaveBeenCalledTimes(1);
  });

  it('logs a check that could not finish rather than failing the request', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mailReputation = mock<Pick<MailReputation, 'view' | 'check'>>();
      mailReputation.view.mockReturnValue({ checking: true } as never);
      mailReputation.check.mockRejectedValue(new Error('no resolver'));
      const started = await (await on(route({ administers: allow, mailReputation }).router)).post(`${prefix}/mail-reputation/check`);
      expect(started.status).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('no resolver'));
    } finally {
      warned.mockRestore();
    }
  });

  it('says so where this server sends no mail itself', async () => {
    const { router } = route({ administers: allow });
    expect((await (await on(router)).get(`${prefix}/mail-reputation`)).status).toBe(404);
    expect((await (await on(router)).post(`${prefix}/mail-reputation/check`)).status).toBe(404);
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
  const send = (router: ReturnType<typeof mailing>['router'], body: unknown) => on(router).then((routes) => routes.post(`${prefix}/mail`, body, { headers: asInstance }));

  it('sends only to the instance\'s owner, in one line and a text', async () => {
    const { mail, router } = mailing();
    mail.toOwner.mockResolvedValue(undefined);
    const answer = await send(router, { subject: 'Alert', text: 'Something fired' });
    expect(answer.data).toEqual({ sent: true });
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
    expect([answer.status, answer.data]).toEqual([503, { error: 'this root sends no email' }]);
  });

  it('holds mail back past the hourly allowance, telling the owner once', async () => {
    const until = Date.parse('2026-11-02T13:00:00.000Z');
    const { mail, router } = mailing({ send: false, tell: true, until, window: { sent: [] } });
    mail.toOwner.mockResolvedValue(undefined);
    const held = await send(router, { subject: 'a', text: 'b' });
    expect([held.status, held.data]).toEqual([429, { error: 'this instance has sent as many emails as an hour allows; more are held back until 2026-11-02T13:00:00.000Z' }]);
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
    expect((await send(router, { subject: 'a', text: 'b' })).data).toEqual({ sent: true });
  });

  it('passes on what the mailer says, and calls any other failure a bad gateway', async () => {
    const { mail, router } = mailing();
    mail.toOwner.mockRejectedValueOnce(new MailError(422, 'that address does not take mail'));
    const refused = await send(router, { subject: 'a', text: 'b' });
    expect([refused.status, refused.data]).toEqual([422, { error: 'that address does not take mail' }]);
    mail.toOwner.mockRejectedValueOnce(new Error('connection reset'));
    const failed = await send(router, { subject: 'a', text: 'b' });
    expect([failed.status, failed.data]).toEqual([502, { error: 'it could not be sent: connection reset' }]);
  });
});

describe('the install.sh join root no longer serves', () => {
  it('answers 404 to a join command asked for, a join made with one and its shell form, from a person or a machine', async () => {
    const { router } = route();
    for (const headers of [undefined, asInstance]) {
      for (const path of ['/join-tokens', '/join', '/join?format=env']) {
        const answer = await (await on(router)).post(`${prefix}${path}`, { name: 'luno', token: 'a-join-token' }, { headers });
        expect(answer.status, path).toBe(404);
      }
    }
  });
});
