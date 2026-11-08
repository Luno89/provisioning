import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { allowed, principalOf, type Principal } from '../../platform/lib/permissions.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { ProjectInviteLimitsService } from '../services/ProjectInviteLimitsService.js';
import { FIRST_ADMIN_INVITE } from '../store.js';
import { adminRouter } from './admin.js';

const quiet = { validateStatus: () => true };
const OPERATOR = { id: 'operator-1', email: 'operator@example.com', roles: ['operator' as const] };
const PERSON = { id: 'person-1', email: 'person@example.com' };

let harness: Harness;

const invite = (id: string, extra: object = {}) => ({ id, codeHash: inviteCodeHash(id), createdBy: OPERATOR.id, createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', ...extra });

beforeAll(async () => {
  harness = await mountRouter({
    prefix: '/api/admin',
    user: OPERATOR,
    router: (db) => adminRouter({
      db,
      operatorOnly: (req: Request, res: Response, next: NextFunction) => (allowed((req as unknown as { principal: Principal }).principal, 'manage-accounts', { kind: 'install' }) ? next() : res.status(403).json({ error: 'Admin only' })),
      inviteLimits: new ProjectInviteLimitsService({ store: db.accounts, principalFor: (user) => principalOf(user, { role: 'root' }) }),
    }),
  });
});

afterAll(async () => { await harness.close(); });

describe('/api/admin over HTTP', () => {
  it('makes an invite showing its code once, keeps only its hash, and lists it without project invites or the first admin\'s setup', async () => {
    harness.setUser(OPERATOR);
    await harness.db.accounts.saveInvite(invite('shared', { project: { name: 'Shop', role: 'client', join: 'j' } }) as never);
    await harness.db.accounts.saveInvite(invite(FIRST_ADMIN_INVITE) as never);
    const made = await axios.post<{ id: string; code: string }>(harness.url('/api/admin/invites'));
    expect(made.status).toBe(201);
    const held = (await harness.db.accounts.getInvites()).find((entry) => entry.id === made.data.id);
    expect(held).toMatchObject({ codeHash: inviteCodeHash(made.data.code), createdBy: OPERATOR.id });
    expect(JSON.stringify(held)).not.toContain(made.data.code);
    const listed = await axios.get<Array<{ id: string }>>(harness.url('/api/admin/invites'));
    expect(listed.data.map((entry) => entry.id)).toEqual([made.data.id]);
    expect(JSON.stringify(listed.data)).not.toContain('codeHash');
  });

  it('turns away anyone who is not an operator, before the router acts', async () => {
    harness.setUser(PERSON);
    expect((await axios.get(harness.url('/api/admin/invites'), quiet)).status).toBe(403);
    expect((await axios.post(harness.url('/api/admin/invites'), undefined, quiet)).status).toBe(403);
    expect((await axios.put(harness.url('/api/admin/project-invites'), { accounts: 3 }, quiet)).status).toBe(403);
  });

  it('shows the project invite limits and each person\'s part in them, and changes them, answering with the new ones or why not', async () => {
    harness.setUser(OPERATOR);
    await harness.db.accounts.saveUser({ id: PERSON.id, email: PERSON.email } as never);
    const shown = await axios.get<{ accounts: number; perHour: number; people: Array<{ id: string }> }>(harness.url('/api/admin/project-invites'));
    expect(shown.data.people.map((person) => person.id)).toEqual([PERSON.id]);

    const changed = await axios.put<{ accounts: number }>(harness.url('/api/admin/project-invites'), { accounts: 3 });
    expect(changed.data).toMatchObject({ accounts: 3, perHour: shown.data.perHour });
    const refused = await axios.put<{ error: string }>(harness.url('/api/admin/project-invites'), { perHour: 0 }, quiet);
    expect(refused.status).toBe(400);
    expect(typeof refused.data.error).toBe('string');
    expect((await axios.get<{ accounts: number }>(harness.url('/api/admin/project-invites'))).data.accounts).toBe(3);
  });

  it('gives one person an allowance of their own, or says there is no such account', async () => {
    harness.setUser(OPERATOR);
    const own = await axios.put(harness.url(`/api/admin/people/${PERSON.id}/project-invites`), { accounts: 25 });
    expect(own.data).toMatchObject({ id: PERSON.id, own: 25 });
    expect((await harness.db.accounts.getUserById(PERSON.id))?.inviteAccounts).toBe(25);
    const missing = await axios.put(harness.url('/api/admin/people/nobody/project-invites'), { accounts: 3 }, quiet);
    expect(missing).toMatchObject({ status: 404, data: { error: 'There is no such account' } });
  });

  it('says accounts are not removed here where the router is not given a removal service', async () => {
    harness.setUser(OPERATOR);
    expect(await axios.get(harness.url('/api/admin/people'), quiet)).toMatchObject({ status: 404, data: { error: 'Accounts cannot be removed here' } });
    expect((await axios.delete(harness.url('/api/admin/people/person-1'), quiet)).status).toBe(404);
  });
});
