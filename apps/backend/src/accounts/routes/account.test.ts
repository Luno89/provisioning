import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { accountRouter } from './account.js';
import { adminRouter } from './admin.js';
import { AccountRemovalService, type AccountRemovalWorkflows, type RemovalWorkflowState } from '../services/AccountRemovalService.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW } from '../lib/account-removal.js';
import { HubService } from '../../hub/services/HubService.js';
import { localHubPeople, type HubPeople } from '../../hub/services/HubPeople.js';
import { memoryHubStore } from '../../hub/lib/hub-store.js';

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
  await db.accounts.saveUser({ id: ADMIN.id, email: ADMIN.email, isAdmin: true, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
  await db.accounts.saveUser({ id: PERSON.id, email: PERSON.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
};

const requireAdmin = (req: Request, res: Response, next: NextFunction) =>
  ((req as unknown as { user?: { isAdmin?: boolean } }).user?.isAdmin ? next() : res.status(403).json({ error: 'Admin only' }));

const mount = async (prefix: '/api/account' | '/api/admin', hub?: HubPeople) => {
  harness = await mountRouter({
    prefix,
    user: PERSON,
    router: async (db) => {
      await seedPeople(db);
      const removal = new AccountRemovalService({ store: db, workflows, now: () => 'now', hub });
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
    expect((await harness.db.accounts.getUserById(PERSON.id))?.removal).toEqual({ startedAt: 'now', requestedBy: PERSON.id });
  });

  it('refuses while something of yours still runs on a cluster, naming it', async () => {
    await mount('/api/account');
    await harness.db.infrastructure.saveDeployment({ id: 'd1', name: 'odoo', clusterId: 'c1', ownerId: PERSON.id, strategy: 'helm' } as never);

    const refused = await call('delete', '/api/account', { confirm: PERSON.email });
    expect(refused.status).toBe(409);
    expect(refused.data.blockers).toEqual(['the app "odoo" is still deployed; remove it first']);
    expect((await harness.db.accounts.getUserById(PERSON.id))?.removal).toBeUndefined();
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

describe('an admin on root', () => {
  it('lists each account with its instance, and removes one through root\'s own removal, which takes its instance with it', async () => {
    const types: string[] = [];
    harness = await mountRouter({
      prefix: '/api/admin',
      user: ADMIN,
      router: async (db) => {
        await seedPeople(db);
        await db.instances.saveInstance({ id: 'inst-1', ownerId: PERSON.id, name: 'bob', url: 'https://bob.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then',
          pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 'then', trialEndsAt: '2026-11-03T00:00:00.000Z' } });
        const removal = new AccountRemovalService({
          store: db,
          workflows: { ...workflows, start: async (type, workflowId) => { types.push(type); await workflows.start(type, workflowId, [{ ownerId: PERSON.id }], PERSON.id); } },
          workflowType: ROOT_REMOVAL_WORKFLOW,
          steps: ROOT_REMOVAL_STEPS,
          instances: () => db.instances.getInstances(),
          now: () => 'now',
        });
        return adminRouter({ db, requireAdmin, removal });
      },
    });
    const listed = (await call('get', '/api/admin/people')).data.people as Array<{ id: string; instance?: unknown }>;
    expect(listed.find((person) => person.id === PERSON.id)?.instance).toEqual({ name: 'bob', where: 'pool', status: 'ready', url: 'https://bob.koala.dev', trialEndsAt: '2026-11-03T00:00:00.000Z', autoUpdates: true });
    expect(listed.find((person) => person.id === ADMIN.id)?.instance).toBeUndefined();
    expect((await call('delete', `/api/admin/people/${PERSON.id}`, { confirm: 'wrong@example.com' })).status).toBe(400);
    expect((await call('delete', `/api/admin/people/${PERSON.id}`, { confirm: PERSON.email })).status).toBe(202);
    expect(types).toEqual([ROOT_REMOVAL_WORKFLOW]);
    const after = (await call('get', '/api/admin/people')).data.people as Array<{ id: string; removal?: { steps: string[] } }>;
    expect(after.find((person) => person.id === PERSON.id)?.removal?.steps).toEqual(ROOT_REMOVAL_STEPS);
  });
});

describe('a person removing their own account on root', () => {
  it('sees what goes with it, their instance included, and starts root\'s own removal', async () => {
    const types: string[] = [];
    let cleared = 0;
    harness = await mountRouter({
      prefix: '/api/account',
      user: PERSON,
      router: async (db) => {
        await seedPeople(db);
        await db.instances.saveInstance({ id: 'inst-1', ownerId: PERSON.id, name: 'bob', url: 'https://bob.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then' });
        const removal = new AccountRemovalService({
          store: db,
          workflows: { ...workflows, start: async (type, workflowId) => { types.push(type); await workflows.start(type, workflowId, [{ ownerId: PERSON.id }], PERSON.id); } },
          workflowType: ROOT_REMOVAL_WORKFLOW,
          steps: ROOT_REMOVAL_STEPS,
          instances: () => db.instances.getInstances(),
          now: () => 'now',
        });
        return accountRouter({ removal, clearSession: () => { cleared += 1; } });
      },
    });
    expect((await call('get', '/api/account/removal')).data).toEqual({ email: PERSON.email, blockers: [], instance: { name: 'bob', where: 'own', status: 'ready', url: 'https://bob.koala.dev', autoUpdates: true } });
    expect((await call('delete', '/api/account', { confirm: 'wrong@example.com' })).status).toBe(400);
    expect(types).toEqual([]);
    expect((await call('delete', '/api/account', { confirm: PERSON.email })).status).toBe(202);
    expect(types).toEqual([ROOT_REMOVAL_WORKFLOW]);
    expect(cleared).toBe(1);
  });
});


describe('removing an account that is on shared projects', () => {
  it('is refused while they alone own a project others are on, and otherwise lets them go from every project first', async () => {
    const tokens: string[] = [];
    const sent = new HubService({ store: memoryHubStore(), invites: { send: async (request) => { tokens.push(request.join); return { link: 'l', emailed: false }; } } });
    const shop = await sent.create(PERSON, { name: 'Shop' });
    const alone = await sent.create(PERSON, { name: 'Alone' });
    if (!shop.ok || !alone.ok) throw new Error('not made');
    await sent.invite(PERSON, shop.value.project.id, { email: ADMIN.email, role: 'collaborator' });
    await sent.accept(ADMIN, tokens[0]!);
    await mount('/api/account', localHubPeople(sent));

    expect((await call('get', '/api/account/removal')).data.blockers).toEqual(['you are the only owner of the shared project "Shop", which others are on; make one of them an owner first']);
    const refused = await call('delete', '/api/account', { confirm: PERSON.email });
    expect(refused.status).toBe(409);
    expect(started).toEqual([]);
    expect((await sent.mine(PERSON.id)).length).toBe(2);

    await sent.changeRole(PERSON.id, shop.value.project.id, ADMIN.id, 'owner');
    expect((await call('delete', '/api/account', { confirm: PERSON.email })).status).toBe(202);
    expect(started.length).toBe(1);
    expect(await sent.mine(PERSON.id)).toEqual([]);
    expect((await sent.view(ADMIN.id, alone.value.project.id)).ok).toBe(false);
    expect((await sent.mine(ADMIN.id)).map((entry) => entry.project.name)).toEqual(['Shop']);
  });
});
