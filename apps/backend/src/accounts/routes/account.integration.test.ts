import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { accountRouter } from './account.js';
import { adminRouter } from './admin.js';
import { AccountRemovalService, type AccountRemovalWorkflows, type RemovalWorkflowState } from '../services/AccountRemovalService.js';
import { ProjectInviteLimitsService } from '../services/ProjectInviteLimitsService.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW } from '../lib/account-removal.js';
import { allowed, principalOf, type Principal } from '../../platform/lib/permissions.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { koalaPlacedAndUp } from '../../instances/testing/placed-koala.js';

const ADMIN = { id: 'ana', email: 'ana@example.com', roles: ['operator' as const] };
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
  await db.accounts.saveUser({ id: ADMIN.id, email: ADMIN.email, roles: ['operator' as const], twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
  await db.accounts.saveUser({ id: PERSON.id, email: PERSON.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
};

const operatorOnly = (req: Request, res: Response, next: NextFunction) =>
  (allowed((req as unknown as { principal: Principal }).principal, 'manage-accounts', { kind: 'install' }) ? next() : res.status(403).json({ error: 'Admin only' }));

const PROOF = 'my-own-password-1';
let proofsAsked = 0;
const confirmed = async (req: { body?: { password?: string } }) => {
  proofsAsked += 1;
  return req.body?.password === PROOF ? undefined : { status: 403 as const, error: 'Enter your password to do this' };
};

const principalFor = (user: { id: string; roles?: ('operator')[] | undefined }) => principalOf(user, { role: 'root' });

const mount = async (prefix: '/api/account' | '/api/admin') => {
  harness = await mountRouter({
    prefix,
    user: PERSON,
    router: async (db) => {
      await seedPeople(db);
      const removal = new AccountRemovalService({ store: db, workflows, now: () => 'now', principalFor });
      return prefix === '/api/account'
        ? accountRouter({ removal, clearSession: (res) => { cleared += 1; res.clearCookie('session'); }, confirmed })
        : adminRouter({ db, operatorOnly, removal, inviteLimits: new ProjectInviteLimitsService({ store: db.accounts, principalFor }) });
    },
  });
};

beforeEach(() => {
  started = [];
  states = new Map();
  cleared = 0;
  proofsAsked = 0;
});

afterEach(async () => {
  await harness.close();
});

const call = (method: 'get' | 'delete', path: string, data?: unknown) =>
  axios.request<Record<string, unknown>>({ method, url: harness.url(path), data, validateStatus: () => true });

describe('removing your own account', () => {
  it('shows what would stop it, then removes it once you type your email, and signs you out', async () => {
    await mount('/api/account');
    expect((await call('get', '/api/account/removal')).data).toEqual({ email: PERSON.email, blockers: [] });

    const wrong = await call('delete', '/api/account', { confirm: 'test' });
    expect(wrong.status).toBe(400);
    expect(started).toEqual([]);

    const unproven = await call('delete', '/api/account', { confirm: PERSON.email });
    expect(unproven.status).toBe(403);
    expect(unproven.data.error).toBe('Enter your password to do this');
    expect(started).toEqual([]);
    expect((await harness.db.accounts.getUserById(PERSON.id))?.removal).toBeUndefined();

    const removed = await call('delete', '/api/account', { confirm: PERSON.email, password: PROOF });
    expect(removed.status).toBe(202);
    expect(removed.data).toEqual({ state: { state: 'running', done: [] } });
    expect(started).toEqual([`remove-account-${PERSON.id}`]);
    expect(cleared).toBe(1);
    expect((await harness.db.accounts.getUserById(PERSON.id))?.removal).toEqual({ startedAt: 'now', requestedBy: PERSON.id });
  });

  it('refuses while something of yours still runs on a cluster, naming it', async () => {
    await mount('/api/account');
    await harness.db.infrastructure.saveDeployment({ id: 'd1', name: 'odoo', clusterId: 'c1', ownerId: PERSON.id, strategy: 'helm' } as never);

    const refused = await call('delete', '/api/account', { confirm: PERSON.email, password: PROOF });
    expect(refused.status).toBe(409);
    expect(refused.data.blockers).toEqual(['the app "odoo" is still deployed; remove it first']);
    expect(proofsAsked).toBe(0);
    expect((await harness.db.accounts.getUserById(PERSON.id))?.removal).toBeUndefined();
  });

  it('joins a removal already under way rather than starting another', async () => {
    await mount('/api/account');
    states.set(`remove-account-${PERSON.id}`, { state: 'running', done: ['workflows'] });

    expect((await call('delete', '/api/account', { confirm: PERSON.email, password: PROOF })).data).toEqual({ state: { state: 'running', done: ['workflows'] } });
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
        await db.instances.saveInstance({ id: 'inst-1', ownerId: PERSON.id, name: 'bob', url: 'https://bob.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then' });
        await db.instances.saveReach({ id: 'inst-1', ownerId: PERSON.id }, { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true });
        const removal = new AccountRemovalService({
          store: db,
          workflows: { ...workflows, start: async (type, workflowId) => { types.push(type); await workflows.start(type, workflowId, [{ ownerId: PERSON.id }], PERSON.id); } },
          workflowType: ROOT_REMOVAL_WORKFLOW,
          steps: ROOT_REMOVAL_STEPS,
          instances: () => db.instances.getInstances(),
          watches: () => db.instances.getWatches(),
          now: () => 'now',
          principalFor,
        });
        return adminRouter({ db, operatorOnly, removal, inviteLimits: new ProjectInviteLimitsService({ store: db.accounts, principalFor }) });
      },
    });
    const listed = (await call('get', '/api/admin/people')).data.people as Array<{ id: string; instance?: unknown }>;
    expect(listed.find((person) => person.id === PERSON.id)?.instance).toEqual({ name: 'bob', status: 'ready', url: 'https://bob.koala.dev', autoUpdates: true, unreachableSince: '2026-10-29T10:00:00.000Z' });
    expect(listed.find((person) => person.id === ADMIN.id)?.instance).toBeUndefined();
    expect((await call('delete', `/api/admin/people/${PERSON.id}`, { confirm: 'wrong@example.com' })).status).toBe(400);
    expect((await call('delete', `/api/admin/people/${PERSON.id}`, { confirm: PERSON.email })).status).toBe(202);
    expect(types).toEqual([ROOT_REMOVAL_WORKFLOW]);
    const after = (await call('get', '/api/admin/people')).data.people as Array<{ id: string; removal?: { steps: string[] } }>;
    expect(after.find((person) => person.id === PERSON.id)?.removal?.steps).toEqual(ROOT_REMOVAL_STEPS);
  });
});

describe('an admin on root, for a person whose Koala the machine join put on their machine', () => {
  it('lists the account with its Koala on its own machine, by the name it was placed under', async () => {
    harness = await mountRouter({
      prefix: '/api/admin',
      user: ADMIN,
      router: async (db) => {
        await seedPeople(db);
        const instances = new InstanceService(db, { rootUrl: 'https://app.root.test', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'v1', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev' }, {
          createPreAuthKey: async (ownerId) => ({ key: `key-of-${ownerId}` }),
          listUserDevices: async () => [],
          removeNode: async () => undefined,
        });
        await koalaPlacedAndUp(instances, db, PERSON.id, { id: 'desk', name: 'desk', meshIp: '100.64.0.9' }, 'bob');
        const removal = new AccountRemovalService({ store: db, workflows, workflowType: ROOT_REMOVAL_WORKFLOW, steps: ROOT_REMOVAL_STEPS, instances: () => db.instances.getInstances(), now: () => 'now', principalFor });
        return adminRouter({ db, operatorOnly, removal, inviteLimits: new ProjectInviteLimitsService({ store: db.accounts, principalFor }) });
      },
    });
    const listed = (await call('get', '/api/admin/people')).data.people as Array<{ id: string; instance?: { name?: string; status: string } }>;
    expect(listed.find((person) => person.id === PERSON.id)?.instance).toMatchObject({ name: 'bob', status: 'ready' });
    expect(listed.find((person) => person.id === ADMIN.id)?.instance).toBeUndefined();
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
          principalFor,
        });
        return accountRouter({ removal, clearSession: () => { cleared += 1; }, confirmed });
      },
    });
    expect((await call('get', '/api/account/removal')).data).toEqual({ email: PERSON.email, blockers: [], instance: { name: 'bob', status: 'ready', url: 'https://bob.koala.dev', autoUpdates: true } });
    expect((await call('delete', '/api/account', { confirm: 'wrong@example.com' })).status).toBe(400);
    expect(types).toEqual([]);
    expect((await call('delete', '/api/account', { confirm: PERSON.email, password: PROOF })).status).toBe(202);
    expect(types).toEqual([ROOT_REMOVAL_WORKFLOW]);
    expect(cleared).toBe(1);
  });
});
