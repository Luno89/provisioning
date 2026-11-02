import type { RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import type { Principal } from '../../platform/lib/permissions.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { OPERATOR, PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';
import type { ProjectInviteLimitsService } from '../services/ProjectInviteLimitsService.js';
import { FIRST_ADMIN_INVITE } from '../store.js';
import { adminRouter } from './admin.js';

const letThrough: RequestHandler = (_req, _res, next) => next();
const turnAway: RequestHandler = (_req, res) => { res.status(403).json({ error: 'Admin only' }); };

async function set(options: { removal?: boolean; operatorOnly?: RequestHandler } = {}) {
  const db = memoryDatabase();
  const inviteLimits = mock<ProjectInviteLimitsService>();
  const removal = mock<AccountRemovalService>();
  const routes = await routesInProcess({ prefix: '/api/admin', router: () => adminRouter({ db, operatorOnly: options.operatorOnly ?? letThrough, inviteLimits, removal: options.removal === false ? undefined : removal }), user: PERSON, db });
  return { db, inviteLimits, removal, routes };
}

const invite = (id: string, extra: object = {}) => ({ id, codeHash: inviteCodeHash(id), createdBy: OPERATOR.id, createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', ...extra });

describe('/api/admin invites', () => {
  it('lists the invites an admin made, leaving out project invites and the first admin\'s setup', async () => {
    const { db, routes } = await set();
    await db.accounts.saveInvite(invite('plain'));
    await db.accounts.saveInvite(invite('shared', { project: { name: 'Shop', role: 'client', join: 'j' } }));
    await db.accounts.saveInvite(invite(FIRST_ADMIN_INVITE));
    const answer = await routes.get('/api/admin/invites', { user: OPERATOR });
    expect((answer.data as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['plain']);
    expect(JSON.stringify(answer.data)).not.toContain('codeHash');
  });

  it('makes an invite, showing its code once and keeping only its hash', async () => {
    const { db, routes } = await set();
    const answer = await routes.post('/api/admin/invites', undefined, { user: OPERATOR });
    const made = answer.data as { id: string; code: string };
    expect(answer.status).toBe(201);
    expect(made.code).toEqual(expect.any(String));
    const held = (await db.accounts.getInvites()).find((entry) => entry.id === made.id);
    expect(held).toMatchObject({ codeHash: inviteCodeHash(made.code), createdBy: OPERATOR.id });
    expect(JSON.stringify(held)).not.toContain(made.code);
  });

  it('turns away anyone the operator guard turns away, before the router acts', async () => {
    const { db, routes } = await set({ operatorOnly: turnAway });
    expect((await routes.post('/api/admin/invites', undefined, { user: PERSON })).status).toBe(403);
    expect((await routes.get('/api/admin/invites', { user: PERSON })).status).toBe(403);
    expect(await db.accounts.getInvites()).toEqual([]);
  });
});

describe('/api/admin project invites', () => {
  it('shows the limits and each person\'s part in them', async () => {
    const { inviteLimits, routes } = await set();
    inviteLimits.overview.mockResolvedValue({ accounts: 10, perHour: 20, people: [{ id: 'ann', email: 'ann@example.com', made: 1 }] });
    expect((await routes.get('/api/admin/project-invites', { user: OPERATOR })).data).toEqual({ accounts: 10, perHour: 20, people: [{ id: 'ann', email: 'ann@example.com', made: 1 }] });
  });

  it('changes the limits, answering with the new ones or why not', async () => {
    const { inviteLimits, routes } = await set();
    inviteLimits.setLimits.calledWith(matches<{ accounts?: unknown; perHour?: unknown }>((input) => input.accounts === 3 && input.perHour === undefined)).mockResolvedValue({ ok: true, value: { accounts: 3, perHour: 20 } });
    inviteLimits.setLimits.calledWith(matches<{ accounts?: unknown; perHour?: unknown }>((input) => input.perHour === 0)).mockResolvedValue({ ok: false, status: 400, why: 'perHour must be a whole number from 1 up' });
    expect((await routes.put('/api/admin/project-invites', { accounts: 3 }, { user: OPERATOR })).data).toEqual({ accounts: 3, perHour: 20 });
    const refused = await routes.put('/api/admin/project-invites', { perHour: 0 }, { user: OPERATOR });
    expect(refused.status).toBe(400);
    expect(refused.data).toEqual({ error: 'perHour must be a whole number from 1 up' });
  });

  it('gives one person an allowance of their own, or says there is no such account', async () => {
    const { inviteLimits, routes } = await set();
    inviteLimits.setOwn.calledWith('ann', 25).mockResolvedValue({ ok: true, value: { id: 'ann', email: 'ann@example.com', made: 1, own: 25 } });
    inviteLimits.setOwn.calledWith('nobody', 3).mockResolvedValue({ ok: false, status: 404, why: 'There is no such account' });
    expect((await routes.put('/api/admin/people/ann/project-invites', { accounts: 25 }, { user: OPERATOR })).data).toMatchObject({ own: 25 });
    const missing = await routes.put('/api/admin/people/nobody/project-invites', { accounts: 3 }, { user: OPERATOR });
    expect(missing.status).toBe(404);
    expect(missing.data).toEqual({ error: 'There is no such account' });
  });
});

describe('/api/admin people', () => {
  it('lists the people with how their removal is going', async () => {
    const { removal, routes } = await set();
    removal.people.mockResolvedValue([{ id: 'ann', email: 'ann@example.com', operator: false, createdAt: 'then' }]);
    expect((await routes.get('/api/admin/people', { user: OPERATOR })).data).toEqual({ people: [{ id: 'ann', email: 'ann@example.com', operator: false, createdAt: 'then' }] });
  });

  it('previews a removal, or says there is no such account', async () => {
    const { removal, routes } = await set();
    removal.preview.calledWith('ann').mockResolvedValue({ email: 'ann@example.com', blockers: [] });
    expect((await routes.get('/api/admin/people/ann/removal', { user: OPERATOR })).data).toEqual({ email: 'ann@example.com', blockers: [] });
    const missing = await routes.get('/api/admin/people/nobody/removal', { user: OPERATOR });
    expect(missing.status).toBe(404);
    expect(missing.data).toEqual({ error: 'There is no such account' });
  });

  it('removes an account as the admin asking, without a proof of their own, answering 202', async () => {
    const { removal, routes } = await set();
    removal.remove.mockResolvedValue({ ok: true, state: { state: 'running', done: [] } });
    const answer = await routes.delete('/api/admin/people/ann', { body: { confirm: 'ann@example.com' }, user: OPERATOR });
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ state: { state: 'running', done: [] } });
    const [request, principal, proof] = removal.remove.mock.calls[0] as unknown as [{ ownerId: string; requestedBy: string; confirm: string }, Principal, unknown];
    expect(request).toEqual({ ownerId: 'ann', requestedBy: OPERATOR.id, confirm: 'ann@example.com' });
    expect(principal.id).toBe(OPERATOR.id);
    expect(proof).toBeUndefined();
  });

  it('answers a refused removal with its status and what stands in the way', async () => {
    const { removal, routes } = await set();
    removal.remove.mockResolvedValue({ ok: false, refusal: { status: 409, error: 'The account cannot be removed yet', blockers: ['this is the only admin account; make someone else an admin first'] } });
    const answer = await routes.delete('/api/admin/people/ana', { body: { confirm: 5 }, user: OPERATOR });
    expect(answer.status).toBe(409);
    expect(removal.remove.mock.calls[0]?.[0].confirm).toBe('');
  });

  it('says accounts are not removed here where the service is not given, as an instance does not', async () => {
    const { routes } = await set({ removal: false });
    for (const [method, path] of [['GET', '/people'], ['GET', '/people/ann/removal'], ['DELETE', '/people/ann']] as const) {
      const answer = await routes.request(method, `/api/admin${path}`, { user: OPERATOR });
      expect(answer.status).toBe(404);
      expect(answer.data).toEqual({ error: 'Accounts cannot be removed here' });
    }
  });
});
