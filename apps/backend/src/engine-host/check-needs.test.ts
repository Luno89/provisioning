import { describe, expect, it } from 'vitest';
import { createCheckNeeds, needsOfAccepted, type CheckNeedsDeps } from './check-needs.js';
import { SHIPPED_DEPENDENCIES } from '../extensions/workspace-dependencies.js';
import type { Task } from './tools/tasks.js';
import type { Leaf } from '../projects/lib/leaves.js';

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, ownerId: 'u1', title: id, doneMeans: 'it works', status: 'accepted', dependsOn: [], createdAt: 't0', updatedAt: 't0', leafId: 'l1', ...over,
} as Task);

function world(over: { published?: string[] | null; refuse?: string; written?: boolean; leaves?: Map<string, Leaf> } = {}) {
  const tasks = new Map<string, Task>([
    ['browser', task('browser', { checks: { e2e: { specs: ['e2e'] } } })],
    ['address', task('address', { checks: { e2e: { specs: ['e2e'], url: 'https://shop.test' } } })],
    ['plain', task('plain', { checks: { command: 'npm test' } })],
    ['finished', task('finished', { status: 'done', checks: { e2e: { specs: ['e2e'] } } })],
  ]);
  const changes: unknown[] = [];
  const builds: string[] = [];
  const deps: CheckNeedsDeps = {
    tasks: { list: async () => [...tasks.values()], save: async (saved) => { tasks.set(saved.id, saved); } },
    ...(over.leaves ? { leaves: { list: async () => [...over.leaves!.values()], save: async (leaf: Leaf) => { over.leaves!.set(leaf.id, leaf); } } } : {}),
    published: async () => (over.published === null ? undefined : { provides: over.published ?? ['bash', 'node'] } as never),
    dependencies: async () => SHIPPED_DEPENDENCIES,
    change: async (_ownerId, treeId, change) => {
      changes.push({ treeId, change });
      return over.refuse ? { ok: false, why: over.refuse } : { ok: true, written: over.written ?? true, commit: 'c1', file: { needs: change.needs } };
    },
    build: async (_ownerId, treeId, commit) => { builds.push(`${treeId}@${commit}`); },
    now: () => 't1',
  };
  return { checkNeeds: createCheckNeeds(deps), tasks, changes, builds };
}

describe('giving a tree\'s workspace what its checks need', () => {
  it('commits what is missing, starts the build, and sets the tasks that need it waiting', async () => {
    const { checkNeeds, tasks, changes, builds } = world();
    expect(await checkNeeds('u1', 'tree-1', ['browser', 'address', 'plain', 'finished'])).toEqual({ added: ['koala-e2e', 'playwright'], waiting: ['browser', 'address'] });
    expect(changes).toEqual([{ treeId: 'tree-1', change: { needs: ['koala-e2e', 'playwright'] } }]);
    expect(builds).toEqual(['tree-1@c1']);
    expect(tasks.get('browser')).toMatchObject({ status: 'waiting', evidence: 'waits for the workspace to get koala-e2e: its checks need it' });
    expect(tasks.get('plain')!.status).toBe('accepted');
    expect(tasks.get('finished')!.status).toBe('done');
  });

  it('parks the story of finished work whose check needs what is missing, since its checks run again at the claim', async () => {
    const leaves = new Map<string, Leaf>([['l1', { id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Story', status: 'pending', tasks: ['finished'], createdAt: 't0', updatedAt: 't0' } as Leaf]]);
    const { checkNeeds, tasks } = world({ leaves });
    expect(await checkNeeds('u1', 'tree-1', ['finished'])).toEqual({ added: ['koala-e2e'], waiting: [], parked: ['l1'] });
    expect(tasks.get('finished')!.status).toBe('done');
    expect(leaves.get('l1')!.waitingFor).toEqual({ reason: 'the workspace getting koala-e2e, which its finished work\'s checks need', since: 't1' });
  });

  it('does nothing when the workspace has it built already, or no check needs anything', async () => {
    const built = world({ published: ['bash', 'koala-e2e', 'playwright'] });
    expect(await built.checkNeeds('u1', 'tree-1', ['browser', 'address'])).toEqual({ added: [], waiting: [] });
    expect(built.changes).toEqual([]);
    expect(await world().checkNeeds('u1', 'tree-1', ['plain'])).toEqual({ added: [], waiting: [] });
  });

  it('only commits it for a tree with no workspace yet, which is first composed from main', async () => {
    const fresh = world({ published: null });
    expect(await fresh.checkNeeds('u1', 'tree-1', ['browser'])).toEqual({ added: ['koala-e2e'], waiting: [] });
    expect(fresh.tasks.get('browser')!.status).toBe('accepted');
  });

  it('says why when the file cannot take it, and leaves the tasks as they were', async () => {
    const refused = world({ refuse: 'the file changed on main' });
    expect(await refused.checkNeeds('u1', 'tree-1', ['browser'])).toEqual({ added: [], waiting: [], refused: 'the file changed on main' });
    expect(refused.tasks.get('browser')!.status).toBe('accepted');
  });

  it('finds the tree of a task accepted later through its story', async () => {
    const { checkNeeds, changes } = world();
    const accepted = needsOfAccepted(checkNeeds, {
      leaves: { list: async () => [{ id: 'l1', branchId: 'b1' }] },
      branches: { list: async () => [{ id: 'b1', treeId: 'tree-9' }] },
    });
    expect(await accepted('u1', task('browser', { checks: { e2e: { specs: ['e2e'] } } }))).toMatchObject({ waiting: ['browser'] });
    expect(changes).toEqual([{ treeId: 'tree-9', change: { needs: ['koala-e2e'] } }]);
    expect(await accepted('u1', task('plain', { checks: { command: 'npm test' } }))).toBeUndefined();
  });
});
