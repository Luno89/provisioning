import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACCOUNT_DATA, memoryWatermarkKeys, ownedWorkflowIds, refuseRemoval, removalBlockers, type RemovalWorld } from './account-removal.js';
import { EVAL_COLLECTIONS } from './eval-run.js';

const world = (over: Partial<RemovalWorld> = {}): RemovalWorld => ({
  users: [{ id: 'ana', email: 'ana@example.com', isAdmin: true }, { id: 'bo', email: 'bo@example.com' }],
  clusters: [],
  deployments: [],
  ...over,
});

describe('what stops an account being removed', () => {
  it('refuses the only admin, and any cluster or app still standing, naming each', () => {
    expect(removalBlockers('ana', world({
      clusters: [{ id: 'c1', name: 'prod', status: 'healthy', ownerId: 'ana' }, { id: 'c2', name: 'old', status: 'destroyed', ownerId: 'ana' }, { id: 'c3', name: 'theirs', status: 'healthy', ownerId: 'bo' }],
      deployments: [{ id: 'd1', name: 'odoo', ownerId: 'ana' }],
    }))).toEqual([
      'this is the only admin account; make someone else an admin first',
      'the cluster "prod" is still healthy; destroy it first',
      'the app "odoo" is still deployed; remove it first',
    ]);
  });

  it('lets an admin go when another admin remains, and anyone with nothing standing', () => {
    expect(removalBlockers('ana', world({ users: [{ id: 'ana', email: 'a', isAdmin: true }, { id: 'cy', email: 'c', isAdmin: true }] }))).toEqual([]);
    expect(removalBlockers('bo', world())).toEqual([]);
  });
});

describe('who may remove an account', () => {
  it('lets a person remove their own account once they type its email', () => {
    expect(refuseRemoval({ ownerId: 'bo', requestedBy: 'bo', confirm: ' BO@example.com ' }, world())).toBeUndefined();
    expect(refuseRemoval({ ownerId: 'bo', requestedBy: 'bo', confirm: 'bo' }, world())).toEqual({ status: 400, error: 'Type the account\'s email, bo@example.com, to confirm' });
  });

  it('lets only an admin remove someone else\'s, and says when there is no such account', () => {
    expect(refuseRemoval({ ownerId: 'ana', requestedBy: 'bo', confirm: 'ana@example.com' }, { ...world(), requester: { id: 'bo' } })).toMatchObject({ status: 403 });
    expect(refuseRemoval({ ownerId: 'bo', requestedBy: 'ana', confirm: 'bo@example.com' }, { ...world(), requester: { id: 'ana', isAdmin: true } })).toBeUndefined();
    expect(refuseRemoval({ ownerId: 'nobody', requestedBy: 'ana', confirm: 'x' }, world())).toMatchObject({ status: 404 });
  });

  it('carries the blockers with a refusal', () => {
    expect(refuseRemoval({ ownerId: 'bo', requestedBy: 'bo', confirm: 'bo@example.com' }, world({ deployments: [{ id: 'd', name: 'wp', ownerId: 'bo' }] })))
      .toEqual({ status: 409, error: 'The account cannot be removed yet', blockers: ['the app "wp" is still deployed; remove it first'] });
  });
});

describe('what an account owns outside the records', () => {
  it('names every workflow its runs, the memory keeper on each run, trees, conversations, plans and bench could have running', () => {
    expect(ownedWorkflowIds('bo', { runIds: ['run-1'], treeIds: ['t1'], conversationIds: ['c1'], proposalIds: ['p1'] })).toEqual([
      'bench-idle-bo', 'run-1', 'memory-run-run-1', 'grove-run-t1', 'conclude-workspace-tree-t1', 'conclude-conversation-c1', 'conclude-workspace-conversation-c1', 'adopt-plan-p1',
    ]);
    expect(memoryWatermarkKeys({ conversationIds: ['c1'] })).toEqual(['conversation:c1']);
  });
});

describe('the records an account leaves', () => {
  it('cover every collection the database uses: each is removed by owner, by id, through what it relates to, or is shared', () => {
    const source = readFileSync(new URL('./mongo-db.ts', import.meta.url), 'utf8');
    const used = new Set([...source.matchAll(/collection\('([A-Za-z_]+)'\)/g)].map((match) => match[1]!));
    for (const name of EVAL_COLLECTIONS) used.add(name);
    const classified = new Set<string>([...ACCOUNT_DATA.byOwner, ...ACCOUNT_DATA.byId, ...Object.keys(ACCOUNT_DATA.related), ACCOUNT_DATA.last, ...ACCOUNT_DATA.shared]);

    expect([...used].filter((name) => !classified.has(name)).sort()).toEqual([]);
  });
});

describe('how long removal waits after stopping a run', () => {
  it('outlasts at least two heartbeats, the most an engine activity takes to hear it was stopped and stop writing', async () => {
    const { ACTIVITY_STOP_GRACE_MS } = await import('./account-removal.js');
    const { NODE_HEARTBEAT_MS } = await import('../engine-host/temporal/activities.js');
    expect(ACTIVITY_STOP_GRACE_MS).toBeGreaterThanOrEqual(2 * NODE_HEARTBEAT_MS);
  });
});
