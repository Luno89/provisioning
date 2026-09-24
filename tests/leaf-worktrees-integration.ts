import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { createEngineActivities } from '../apps/backend/src/engine-host/temporal/activities.js';
import type { RunTicket } from '../apps/backend/src/engine-host/temporal/contracts.js';
import type { Branch, Leaf } from '../apps/backend/src/lib/leaves.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = 'leaf-worktrees-integration';

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const host = liveEngineHost(db);
  const activities = createEngineActivities({
    environments: host.environments,
    treeWorkspaces: host.treeWorkspaces,
    grove: {
      trees: { list: () => db.getTrees() },
      branches: { list: () => db.getBranches() },
      leaves: { list: () => db.getLeaves(), save: (leaf) => db.saveLeaf(leaf) },
      tasks: { list: () => db.getTasks() },
    },
    tasks: { list: (ownerId: string) => db.getTasks(ownerId), save: (task: never) => db.saveTask(task) },
  } as never);

  const stamp = new Date().toISOString();
  const suffix = Date.now().toString(36);
  const treeId = `wt-${suffix}`;
  const branch: Branch = { id: `${treeId}-b`, ownerId: OWNER, treeId, title: 'Proof', messages: [], createdAt: stamp, updatedAt: stamp };
  const leaf = (id: string, over: Partial<Leaf> = {}): Leaf => ({
    id, ownerId: OWNER, branchId: branch.id, title: id, body: `${id} exists`, column: 'todo', status: 'pending',
    runner: 'engine', depth: 0, blocking: false, createdAt: stamp, updatedAt: stamp, ...over,
  });
  const leafA = leaf(`${treeId}-a`);
  const leafB = leaf(`${treeId}-b`, { dependsOn: [leafA.id] });
  const taskId = `${treeId}-task-a`;

  await db.saveTree({ id: treeId, ownerId: OWNER, name: 'Worktree proof', type: 'freeform', projectIds: [], createdAt: stamp, updatedAt: stamp });
  await db.saveBranch(branch);
  await db.saveLeaf(leafA);
  await db.saveLeaf(leafB);

  const shared = await host.treeWorkspaces.describe({ treeId, ownerId: OWNER });
  const handle = (worktree: string) => ({ id: shared.id, spec: shared.capabilities, workspace: shared.workspace, scope: { worktree } });
  const ticket = (runId: string, agentSlug: string): RunTicket => ({ runId, depth: 1, ownerId: OWNER, agentSlug, trigger: 'agent' });

  try {
    console.log('[1/6] preparing leaf A\'s worktree');
    const first = await activities.GrovePrepareWorkActivity({ treeId, ownerId: OWNER, leafIds: [leafA.id] });
    assert.deepEqual(first, { ready: [leafA.id], failed: [] });

    console.log('[2/6] an executor in A\'s worktree does its task and leaves the file uncommitted');
    const inA = await host.environments.forRun({ ticket: ticket(`exec-${suffix}`, 'executor'), environment: handle(`trees/${leafA.id}`) });
    assert.ok(inA);
    const wrote = await inA.exec({ command: 'echo "from leaf A" > a.txt && git branch --show-current' });
    assert.equal(wrote.stdout.trim(), `leaf/${leafA.id}`, 'the executor is not on the leaf\'s branch in its worktree');
    await db.saveTask({
      id: taskId, ownerId: OWNER, leafId: leafA.id, title: 'Write a.txt', doneMeans: 'a.txt says from leaf A',
      dependsOn: [], status: 'done', runs: [`exec-${suffix}`], evidence: 'wrote a.txt; cat a.txt → from leaf A', createdAt: stamp, updatedAt: stamp,
    });

    console.log('[3/6] the leaf runner commits what the task left, claims at that commit with the task\'s evidence');
    const claimed = await activities.GroveClaimActivity({ treeId, ownerId: OWNER, leafId: leafA.id, result: 'claimed' });
    assert.equal(claimed.ok, true, claimed.digest);
    const head = (await inA.exec({ command: 'git rev-parse HEAD' })).stdout.trim();
    assert.match((await inA.exec({ command: 'git log -1 --format=%s && git status --porcelain' })).stdout.trim(), /^leaf .*: work its tasks left uncommitted$/);
    const claimRecord = (await db.getLeaves()).find((entry) => entry.id === leafA.id)?.claim;
    assert.equal(claimRecord?.commit, head);
    assert.match(claimRecord?.evidence ?? '', /- Write a\.txt \[done\] \(runs: exec-.*\)\n  wrote a\.txt; cat a\.txt → from leaf A/);

    console.log('[4/6] the judge\'s checkout is exactly the claimed commit; a claim it keeps for a person leaves the judge pass');
    const checkouts = await activities.GroveJudgeCheckoutActivity({ treeId, ownerId: OWNER, leafIds: [leafA.id] });
    assert.equal(checkouts[leafA.id], head);
    const judge = await host.environments.forRun({ ticket: ticket(`judge-${suffix}`, 'leaf-judge'), environment: handle(`judge/${leafA.id}`) });
    assert.ok(judge);
    assert.equal((await judge.exec({ command: 'git rev-parse HEAD && cat a.txt' })).stdout.trim(), `${head}\nfrom leaf A`);
    const settle = (verdict: string, note: string) => host.tools.run({
      ticket: ticket(`judge-${suffix}`, 'leaf-judge'),
      nodeId: 'tools',
      name: 'settle_leaf',
      arguments: JSON.stringify({ leafId: leafA.id, verdict, note }),
      environment: handle(`judge/${leafA.id}`),
    });
    const kept = await settle('stay-claimed', 'a.txt is there but nothing says it is the right text');
    assert.equal(kept.ok, true, kept.digest);
    const parked = await activities.GrovePartitionActivity({ treeId, ownerId: OWNER });
    assert.deepEqual(parked.claimed, [], 'a parked claim went back to the judge');
    assert.deepEqual(parked.awaitingReview.map((entry) => entry.id), [leafA.id]);
    const settled = await settle('verified', 'a.txt at the claimed commit says it');
    assert.equal(settled.ok, true, settled.digest);

    console.log('[5/6] leaf B, which waits on A, starts from A\'s work');
    const second = await activities.GrovePrepareWorkActivity({ treeId, ownerId: OWNER, leafIds: [leafB.id] });
    assert.deepEqual(second, { ready: [leafB.id], failed: [] });
    const inB = await host.environments.forRun({ ticket: ticket(`execB-${suffix}`, 'executor'), environment: handle(`trees/${leafB.id}`) });
    assert.ok(inB);
    assert.equal((await inB.exec({ command: 'git branch --show-current && cat a.txt' })).stdout.trim(), `leaf/${leafB.id}\nfrom leaf A`);

    console.log('[6/6] the two leaves never shared a working directory');
    assert.equal((await inB.exec({ command: 'pwd' })).stdout.trim(), `/work/trees/${leafB.id}`);
    assert.equal((await inA.exec({ command: 'pwd' })).stdout.trim(), `/work/trees/${leafA.id}`);

    console.log('\nleaf worktrees: own branch per leaf, claim pinned to a commit, judge on that commit, dependents built on it — PASS');
  } finally {
    await host.treeWorkspaces.release(treeId).catch(() => undefined);
    await db.deleteTask(taskId);
    await db.deleteLeaf(leafA.id);
    await db.deleteLeaf(leafB.id);
    await db.deleteBranch(branch.id);
    await db.deleteTree(treeId);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
