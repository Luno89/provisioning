import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { accountRouter } from './account.js';
import { adminRouter } from './admin.js';
import { AccountRemovalService, type AccountRemovalWorkflows, type RemovalWorkflowState } from '../services/AccountRemovalService.js';
import type { Database } from '../lib/db-interface.js';

const ADMIN = { id: 'ana', email: 'ana@example.com', isAdmin: true };
const PERSON = { ...TEST_USER };

let started: string[];
let states: Map<string, RemovalWorkflowState>;
let cleared: number;
let harness: Harness;

const workflows: AccountRemovalWorkflows = {
  start: async (_type, workflowId) => { started.push(workflowId); states.set(workflowId, { state: 'running', done: [] }); },
  state: async (workflowId) => states.get(workflowId) ?? { state: 'none' },
};

const seedPeople = async (db: Database) => {
  await db.saveUser({ id: ADMIN.id, email: ADMIN.email, isAdmin: true, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
  await db.saveUser({ id: PERSON.id, email: PERSON.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
};

const requireAdmin = (req: Request, res: Response, next: NextFunction) =>
  ((req as unknown as { user?: { isAdmin?: boolean } }).user?.isAdmin ? next() : res.status(403).json({ error: 'Admin only' }));

const mount = async (prefix: '/api/account' | '/api/admin') => {
  harness = await mountRouter({
    prefix,
    user: PERSON,
    router: async (db) => {
      await seedPeople(db);
      const removal = new AccountRemovalService({ store: db, workflows, now: () => 'now' });
      return prefix === '/api/account'
        ? accountRouter({ removal, clearSession: (res) => { cleared += 1; res.clearCookie('session'); } })
        : adminRouter({ db, requireAdmin, removal });
    },
  });
};

beforeEach(() => {
  started = [];
  states = new Map();
  cleared = 0;
});

afterEach(async () => {
  await harness.close();
});

const call = (method: 'get' | 'delete', path: string, data?: unknown) =>
  axios.request({ method, url: harness.url(path), data, validateStatus: () => true });

describe('removing your own account', () => {
  it('shows what would stop it, then removes it once you type your email, and signs you out', async () => {
    await mount('/api/account');
    expect((await call('get', '/api/account/removal')).data).toEqual({ email: PERSON.email, blockers: [] });

    const wrong = await call('delete', '/api/account', { confirm: 'test' });
    expect(wrong.status).toBe(400);
    expect(started).toEqual([]);

    const removed = await call('delete', '/api/account', { confirm: PERSON.email });
    expect(removed.status).toBe(202);
    expect(removed.data).toEqual({ state: { state: 'running', done: [] } });
    expect(started).toEqual([`remove-account-${PERSON.id}`]);
    expect(cleared).toBe(1);
    expect((await harness.db.getUserById(PERSON.id))?.removal).toEqual({ startedAt: 'now', requestedBy: PERSON.id });
  });

  it('refuses while something of yours still runs on a cluster, naming it', async () => {
    await mount('/api/account');
    await harness.db.saveDeployment({ id: 'd1', name: 'odoo', clusterId: 'c1', ownerId: PERSON.id, strategy: 'helm' } as never);

    const refused = await call('delete', '/api/account', { confirm: PERSON.email });
    expect(refused.status).toBe(409);
    expect(refused.data.blockers).toEqual(['the app "odoo" is still deployed; remove it first']);
    expect((await harness.db.getUserById(PERSON.id))?.removal).toBeUndefined();
  });

  it('joins a removal already under way rather than starting another', async () => {
    await mount('/api/account');
    states.set(`remove-account-${PERSON.id}`, { state: 'running', done: ['workflows'] });

    expect((await call('delete', '/api/account', { confirm: PERSON.email })).data).toEqual({ state: { state: 'running', done: ['workflows'] } });
    expect(started).toEqual([]);
  });
});

describe('an admin removing someone else\'s account', () => {
  it('lists people with how their removal is going, and removes another account', async () => {
    await mount('/api/admin');
    harness.setUser(ADMIN);

    const removed = await call('delete', `/api/admin/people/${PERSON.id}`, { confirm: PERSON.email });
    expect(removed.status).toBe(202);
    const people = (await call('get', '/api/admin/people')).data.people as { id: string; removal?: unknown }[];
    expect(people.find((person) => person.id === PERSON.id)?.removal).toEqual({ startedAt: 'now', requestedBy: ADMIN.id, state: { state: 'running', done: [] } });
    expect(people.find((person) => person.id === ADMIN.id)?.removal).toBeUndefined();
  });

  it('will not remove the only admin, and lets nobody else in', async () => {
    await mount('/api/admin');
    harness.setUser(ADMIN);
    const self = await call('delete', `/api/admin/people/${ADMIN.id}`, { confirm: ADMIN.email });
    expect(self.status).toBe(409);
    expect(self.data.blockers).toEqual(['this is the only admin account; make someone else an admin first']);

    harness.setUser(PERSON);
    expect((await call('delete', `/api/admin/people/${ADMIN.id}`, { confirm: ADMIN.email })).status).toBe(403);
    expect((await call('get', '/api/admin/people')).status).toBe(403);
  });
});
