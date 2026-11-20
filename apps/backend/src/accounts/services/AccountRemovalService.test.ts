import { withWorkFor, workIsUnnamed } from '@koala/engine-core/work-for';
import type { Client } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import type { HubPeople } from '../../hub/index.js';
import type { InstanceRecord, InstanceRelease, InstanceWatchRecord } from '../../instances/index.js';
import { principalOf, type Principal } from '../../platform/lib/permissions.js';
import { OWNER_ATTRIBUTE } from '../../platform/lib/workflow-owner.js';
import type { AccessRevoked } from '../../platform/lib/revocations.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { REMOVE_ACCOUNT_WORKFLOW, ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId } from '../lib/account-removal.js';
import { type UndeliveredLogout, AccountRemovalService, temporalRemovalWorkflows, type AccountRemovalWorkflows } from './AccountRemovalService.js';

const principalFor = (user: Pick<UserMetadata, 'id' | 'roles'>): Principal => principalOf(user, { role: 'root' });

const user = (id: string, extra: Partial<UserMetadata> = {}): UserMetadata => ({ id, email: `${id}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: 'then', ...extra });

async function set(options: { hub?: HubPeople; instances?: InstanceRecord[]; releases?: InstanceRelease[]; current?: string; watches?: InstanceWatchRecord[]; logouts?: UndeliveredLogout[]; steps?: boolean } = {}) {
  const db = memoryDatabase();
  await db.accounts.saveUser(user('ana', { roles: ['operator'] }));
  await db.accounts.saveUser(user('bob'));
  const workflows = mock<AccountRemovalWorkflows>();
  workflows.state.mockResolvedValue({ state: 'none' });
  const revoked: AccessRevoked[] = [];
  const service = new AccountRemovalService({
    store: db,
    workflows,
    now: () => 'now',
    principalFor,
    revocations: { revoked: async (event) => { revoked.push(event); } },
    hub: options.hub,
    instances: options.instances ? async () => options.instances! : undefined,
    releases: options.releases ? async () => options.releases! : undefined,
    currentRelease: options.current,
    watches: options.watches ? async () => options.watches! : undefined,
    logouts: options.logouts ? async () => options.logouts! : undefined,
    ...(options.steps ? { workflowType: ROOT_REMOVAL_WORKFLOW, steps: ROOT_REMOVAL_STEPS } : {}),
  });
  return { db, workflows, revoked, service };
}

const asBob = principalOf({ id: 'bob' }, { role: 'root' });
const asAna = principalOf({ id: 'ana', roles: ['operator'] }, { role: 'root' });

describe('what removing an account would take', () => {
  it('names the account and what stands in the way', async () => {
    const { db, service } = await set();
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'odoo', clusterId: 'c1', ownerId: 'bob', strategy: 'helm' } as never);
    expect(await service.preview('bob')).toEqual({ email: 'bob@example.com', blockers: ['the app "odoo" is still deployed; remove it first'] });
    expect(await service.preview('ana')).toEqual({ email: 'ana@example.com', blockers: ['this is the only admin account; make someone else an admin first'] });
  });

  it('says there is no such account', async () => {
    const { service } = await set();
    expect(await service.preview('nobody')).toBeUndefined();
  });

  it('adds what the hub says the person is the only owner of', async () => {
    const hub = mock<HubPeople>();
    hub.blockers.calledWith('bob').mockResolvedValue(['you are the only owner of the shared project "Shop", which others are on; make one of them an owner first']);
    const { service } = await set({ hub });
    expect((await service.preview('bob'))?.blockers).toEqual(['you are the only owner of the shared project "Shop", which others are on; make one of them an owner first']);
  });

  it('shows the person\'s instance, where there is one', async () => {
    const instance = { id: 'inst-1', ownerId: 'bob', name: 'bob', url: 'https://bob.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then' } as InstanceRecord;
    const { service } = await set({ instances: [instance] });
    expect(await service.preview('bob')).toEqual({ email: 'bob@example.com', blockers: [], instance: { name: 'bob', status: 'ready', url: 'https://bob.koala.dev', autoUpdates: true } });
    expect((await service.preview('ana'))?.instance).toBeUndefined();
  });
});

describe('removing an account', () => {
  it('marks the account, tells the others to drop its sessions and starts the removal as that person', async () => {
    const { db, workflows, revoked, service } = await set();
    workflows.state.mockResolvedValueOnce({ state: 'none' }).mockResolvedValueOnce({ state: 'running', done: [] });
    const outcome = await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'Bob@Example.com' }, asBob);
    expect(outcome).toEqual({ ok: true, state: { state: 'running', done: [] } });
    expect((await db.accounts.getUserById('bob'))?.removal).toEqual({ startedAt: 'now', requestedBy: 'bob' });
    expect(revoked).toEqual([{ personId: 'bob', because: 'account-removed', at: 'now' }]);
    expect(workflows.start).toHaveBeenCalledWith(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('bob'), [{ ownerId: 'bob' }], 'bob');
  });

  it('starts the removal as work for nobody, so the fence it raises round the account never stops its own steps', async () => {
    const { workflows, service } = await set();
    let unnamed: boolean | undefined;
    workflows.start.mockImplementation(async () => { unnamed = workIsUnnamed(); });
    await withWorkFor({ owner: 'bob' }, () => service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob));
    expect(unnamed).toBe(true);
  });

  it('starts root\'s own removal where it is told to', async () => {
    const { workflows, service } = await set({ steps: true });
    await service.remove({ ownerId: 'bob', requestedBy: 'ana', confirm: 'bob@example.com' }, asAna);
    expect(workflows.start).toHaveBeenCalledWith(ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId('bob'), [{ ownerId: 'bob' }], 'bob');
  });

  it('lets an admin remove someone else\'s account and nobody else\'s', async () => {
    const { db, workflows, service } = await set();
    await db.accounts.saveUser(user('cy'));
    const refused = await service.remove({ ownerId: 'cy', requestedBy: 'bob', confirm: 'cy@example.com' }, asBob);
    expect(refused).toMatchObject({ ok: false, refusal: { status: 403 } });
    expect((await service.remove({ ownerId: 'cy', requestedBy: 'ana', confirm: 'cy@example.com' }, asAna)).ok).toBe(true);
    expect(workflows.start).toHaveBeenCalledTimes(1);
  });

  it('refuses what is not an account, a confirmation that is not the email, and what stands in the way', async () => {
    const { db, workflows, service } = await set();
    expect(await service.remove({ ownerId: 'nobody', requestedBy: 'ana', confirm: 'x' }, asAna)).toEqual({ ok: false, refusal: { status: 404, error: 'There is no such account' } });
    expect(await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'wrong@example.com' }, asBob)).toMatchObject({ ok: false, refusal: { status: 400 } });
    expect(await service.remove({ ownerId: 'ana', requestedBy: 'ana', confirm: 'ana@example.com' }, asAna)).toMatchObject({ ok: false, refusal: { status: 409, blockers: ['this is the only admin account; make someone else an admin first'] } });
    expect(workflows.start).not.toHaveBeenCalled();
    expect((await db.accounts.getUserById('bob'))?.removal).toBeUndefined();
  });

  it('joins a removal already under way rather than starting another', async () => {
    const { db, workflows, service } = await set();
    workflows.state.mockResolvedValue({ state: 'running', done: ['workflows'] });
    expect(await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob)).toEqual({ ok: true, state: { state: 'running', done: ['workflows'] } });
    expect(workflows.start).not.toHaveBeenCalled();
    expect((await db.accounts.getUserById('bob'))?.removal).toBeUndefined();
  });

  it('asks the proof only once nothing else refuses, and changes nothing without it', async () => {
    const { db, workflows, revoked, service } = await set();
    let asked = 0;
    const refusal = { status: 403 as const, error: 'Enter your password to do this' };
    expect(await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'wrong' }, asBob, async () => { asked += 1; return refusal; })).toMatchObject({ refusal: { status: 400 } });
    expect(asked).toBe(0);
    expect(await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob, async () => { asked += 1; return refusal; })).toEqual({ ok: false, refusal });
    expect(asked).toBe(1);
    expect(workflows.start).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
    expect((await db.accounts.getUserById('bob'))?.removal).toBeUndefined();
  });

  it('goes ahead when the proof comes back clean', async () => {
    const { workflows, service } = await set();
    expect((await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob, async () => undefined)).ok).toBe(true);
    expect(workflows.start).toHaveBeenCalledTimes(1);
  });

  it('is refused while the hub says the account is the only owner of a shared project, and lets the person go from the hub first otherwise', async () => {
    const hub = mock<HubPeople>();
    hub.blockers.mockResolvedValueOnce(['you are the only owner of the shared project "Shop", which others are on; make one of them an owner first']);
    const { workflows, service } = await set({ hub });
    const refused = await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob);
    expect(refused).toMatchObject({ ok: false, refusal: { status: 409, error: 'The account cannot be removed yet', blockers: [expect.stringContaining('Shop')] } });
    expect(hub.letGo).not.toHaveBeenCalled();
    hub.blockers.mockResolvedValue([]);
    expect((await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob)).ok).toBe(true);
    expect(hub.letGo).toHaveBeenCalledWith('bob');
    expect(workflows.start).toHaveBeenCalledTimes(1);
  });

  it('does not let the hub go before the proof is given', async () => {
    const hub = mock<HubPeople>();
    hub.blockers.mockResolvedValue([]);
    const { service } = await set({ hub });
    await service.remove({ ownerId: 'bob', requestedBy: 'bob', confirm: 'bob@example.com' }, asBob, async () => ({ status: 403, error: 'no' }));
    expect(hub.letGo).not.toHaveBeenCalled();
  });
});

describe('the people on root', () => {
  const instance = (extra: Partial<InstanceRecord> = {}) => ({ id: 'inst-1', ownerId: 'bob', name: 'bob', url: 'https://bob.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then', ...extra }) as InstanceRecord;

  it('lists each person, leaving out check spaces, with whether they are an operator', async () => {
    const { db, service } = await set();
    await db.accounts.saveUser(user('space-1', { space: { person: 'bob', checkRunId: 'c', scenarioId: 's', models: 'borrowed', world: {} } }));
    expect(await service.people()).toEqual([
      { id: 'ana', email: 'ana@example.com', operator: true, createdAt: 'then' },
      { id: 'bob', email: 'bob@example.com', operator: false, createdAt: 'then' },
    ]);
  });

  it('shows how a removal is going, with the steps it takes where they are known', async () => {
    const { db, workflows, service } = await set({ steps: true });
    await db.accounts.saveUser(user('bob', { removal: { startedAt: 'then', requestedBy: 'ana' } }));
    workflows.state.mockImplementation(async (id) => (id === removeAccountWorkflowId('bob') ? { state: 'running', done: ['instance'] } : { state: 'none' }));
    const bob = (await service.people()).find((person) => person.id === 'bob');
    expect(bob?.removal).toEqual({ startedAt: 'then', requestedBy: 'ana', state: { state: 'running', done: ['instance'] }, steps: ROOT_REMOVAL_STEPS });
    expect((await service.people()).find((person) => person.id === 'ana')?.removal).toBeUndefined();
  });

  it('shows an instance with the release it runs and whether root withdrew it', async () => {
    const releases = [
      { imageTag: 'b2', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z' },
      { imageTag: 'c3', version: 'v2026.10.26', servedAt: '2026-10-26T00:00:00.000Z', withdrawn: { at: '2026-10-27T00:00:00.000Z', by: 'root rolled back to v2026.10.25' } },
    ] as InstanceRelease[];
    const { service } = await set({
      releases,
      instances: [instance({ running: 'c3', updates: { auto: false, picked: 'c3' } })],
    });
    expect((await service.people()).find((person) => person.id === 'bob')?.instance).toEqual({
      name: 'bob', status: 'ready', url: 'https://bob.koala.dev', version: 'v2026.10.26', versionWithdrawn: true, autoUpdates: false,
    });
  });

  it('says when an instance stays on its release because the one root runs cannot run its data', async () => {
    const releases = [
      { imageTag: 'old', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00.000Z' },
      { imageTag: 'new', version: 'v2026.11.17', servedAt: '2026-11-17T00:00:00.000Z', dataVersion: 1, withdrawn: { at: '2026-11-18T00:00:00.000Z', by: 'root rolled back to v2026.10.30' } },
    ] as InstanceRelease[];
    const { service } = await set({ releases, current: 'old', instances: [instance({ running: 'new', dataVersion: 1 })] });
    expect((await service.people()).find((person) => person.id === 'bob')?.instance).toMatchObject({ version: 'v2026.11.17', heldByData: { version: 'v2026.10.30', needs: 1 } });
  });

  it('names a release root does not know by its tag, and does not call it withdrawn', async () => {
    const { service } = await set({ releases: [], instances: [instance({ running: 'zz9' })] });
    const shown = (await service.people()).find((person) => person.id === 'bob')?.instance;
    expect(shown).toMatchObject({ version: 'zz9' });
    expect(shown?.versionWithdrawn).toBeUndefined();
  });

  it('says when an instance cannot be reached and since when, only once its owner was told', async () => {
    const { service } = await set({
      instances: [instance({ detail: 'checking in' })],
      watches: [{ instanceId: 'inst-1', reach: { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true } }],
    });
    expect((await service.people()).find((person) => person.id === 'bob')?.instance).toMatchObject({ detail: 'checking in', unreachableSince: '2026-10-29T10:00:00.000Z' });
    const quiet = await set({
      instances: [instance()],
      watches: [{ instanceId: 'inst-1', reach: { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z' } }],
    });
    expect((await quiet.service.people()).find((person) => person.id === 'bob')?.instance?.unreachableSince).toBeUndefined();
  });

  it('says since when signing out has not reached an instance, and why it last failed, until it does', async () => {
    const { service } = await set({
      instances: [instance()],
      logouts: [
        { clientId: 'inst-1', revokedAt: '2026-11-08T10:05:00.000Z', attempts: 3, lastError: 'it answered 502', lastTriedAt: '2026-11-08T10:20:00.000Z' },
        { clientId: 'inst-1', revokedAt: '2026-11-08T10:00:00.000Z', attempts: 4, lastError: 'it refused the connection (ECONNREFUSED)', lastTriedAt: '2026-11-08T10:10:00.000Z' },
        { clientId: 'inst-2', revokedAt: '2026-11-08T09:00:00.000Z', attempts: 1, lastError: 'not bob\'s' },
        { clientId: 'inst-1', revokedAt: '2026-11-08T11:00:00.000Z' },
      ],
    });
    expect((await service.people()).find((person) => person.id === 'bob')?.instance?.signOutsUndelivered).toEqual({ since: '2026-11-08T10:00:00.000Z', why: 'it answered 502' });
    const delivered = await set({ instances: [instance()], logouts: [{ clientId: 'inst-1', revokedAt: '2026-11-08T11:00:00.000Z' }] });
    expect((await delivered.service.people()).find((person) => person.id === 'bob')?.instance?.signOutsUndelivered).toBeUndefined();
  });

  it('shows an instance with no status as ready when it has an address and waiting when it has none, and a waiting one as having no update setting', async () => {
    const { service } = await set({ instances: [instance({ status: undefined }), instance({ id: 'inst-2', ownerId: 'ana', url: '', status: 'waiting' })] });
    const people = await service.people();
    expect(people.find((person) => person.id === 'bob')?.instance?.status).toBe('ready');
    const waiting = people.find((person) => person.id === 'ana')?.instance;
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.autoUpdates).toBeUndefined();
  });
});

describe('Temporal\'s part in removing an account', () => {
  const found = (client: ReturnType<typeof mockDeep<Client>>) => temporalRemovalWorkflows(() => client, 'engine-queue');

  it('starts the workflow on its queue as the person it is for', async () => {
    const client = mockDeep<Client>();
    await found(client).start('RemoveAccountWorkflow', 'remove-account-bob', [{ ownerId: 'bob' }], 'bob');
    const [type, options] = client.workflow.start.mock.calls[0] as unknown as [string, { workflowId: string; taskQueue: string; args: unknown[]; typedSearchAttributes: Array<{ key: { name: string }; value: string }> }];
    expect(type).toBe('RemoveAccountWorkflow');
    expect(options).toMatchObject({ workflowId: 'remove-account-bob', taskQueue: 'engine-queue', args: [{ ownerId: 'bob' }] });
    expect(options.typedSearchAttributes.map((pair) => [pair.key.name, pair.value])).toEqual([[OWNER_ATTRIBUTE.name, 'bob']]);
  });

  it('will not start when Temporal cannot be reached, saying why', async () => {
    const workflows = temporalRemovalWorkflows(() => undefined, 'engine-queue');
    await expect(workflows.start('RemoveAccountWorkflow', 'id', [{ ownerId: 'bob' }], 'bob')).rejects.toThrow('Temporal is not reachable, so the account cannot be removed now');
  });

  it('reads no state when Temporal cannot be reached, or does not know the workflow', async () => {
    expect(await temporalRemovalWorkflows(() => null, 'q').state('id')).toEqual({ state: 'none' });
    const client = mockDeep<Client>();
    client.workflow.getHandle.mockReturnValue({ describe: async () => { throw new Error('workflow execution not found'); } } as never);
    expect(await found(client).state('id')).toEqual({ state: 'none' });
  });

  it('shows the steps done while it runs, and none when they cannot be read', async () => {
    const client = mockDeep<Client>();
    const handle = { describe: async () => ({ status: { name: 'RUNNING' } }), query: async () => ['workflows', 'apps'] };
    client.workflow.getHandle.mockReturnValue(handle as never);
    expect(await found(client).state('id')).toEqual({ state: 'running', done: ['workflows', 'apps'] });
    client.workflow.getHandle.mockReturnValue({ ...handle, query: async () => { throw new Error('no progress yet'); } } as never);
    expect(await found(client).state('id')).toEqual({ state: 'running', done: [] });
  });

  it('asks for the progress under the name it was given', async () => {
    const client = mockDeep<Client>();
    const queried: string[] = [];
    client.workflow.getHandle.mockReturnValue({ describe: async () => ({ status: { name: 'RUNNING' } }), query: async (name: string) => { queried.push(name); return []; } } as never);
    await temporalRemovalWorkflows(() => client, 'q', 'rootRemovalProgress').state('id');
    expect(queried).toEqual(['rootRemovalProgress']);
  });

  it('says a workflow that completed finished', async () => {
    const client = mockDeep<Client>();
    client.workflow.getHandle.mockReturnValue({ describe: async () => ({ status: { name: 'COMPLETED' } }) } as never);
    expect(await found(client).state('id')).toEqual({ state: 'finished' });
  });

  it('says why a workflow that did not complete failed, down to the innermost reason, or how it ended', async () => {
    const client = mockDeep<Client>();
    const failed = (result: () => Promise<unknown>) => ({ describe: async () => ({ status: { name: 'FAILED' } }), result });
    client.workflow.getHandle.mockReturnValue(failed(async () => { throw Object.assign(new Error('Workflow execution failed'), { cause: Object.assign(new Error('Activity task failed'), { cause: new Error('the cluster still has apps') }) }); }) as never);
    expect(await found(client).state('id')).toEqual({ state: 'failed', reason: 'the cluster still has apps' });
    client.workflow.getHandle.mockReturnValue(failed(async () => { throw Object.assign(new Error(''), { cause: undefined }); }) as never);
    expect(await found(client).state('id')).toEqual({ state: 'failed', reason: 'failed' });
    client.workflow.getHandle.mockReturnValue({ describe: async () => ({ status: { name: 'TERMINATED' } }), result: async () => 'fine' } as never);
    expect(await found(client).state('id')).toEqual({ state: 'failed', reason: 'terminated' });
  });

  it('lets an error that is not "not found" through', async () => {
    const client = mockDeep<Client>();
    client.workflow.getHandle.mockReturnValue({ describe: async () => { throw new Error('connection refused'); } } as never);
    await expect(found(client).state('id')).rejects.toThrow('connection refused');
  });
});
