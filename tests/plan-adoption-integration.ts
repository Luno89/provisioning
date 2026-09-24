import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { createModelService } from '../apps/backend/src/lib/model-wiring.js';
import { createEngineHost, storesFromDatabase } from '../apps/backend/src/engine-host/host.js';
import { createGroveTools } from '../apps/backend/src/engine-host/tools/grove-tools.js';
import { createPlanAdoption } from '../apps/backend/src/engine-host/plan-adoption.js';
import type { PlanProposal } from '../apps/backend/src/lib/plan-proposals.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = 'plan-adoption-integration';

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const stores = storesFromDatabase(db);
  const host = createEngineHost({
    models: createModelService(db, process.env.JWT_SECRET ?? ''),
    stores,
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
  });

  const conversationId = `conv-${Date.now().toString(36)}`;
  const treeTypes = await stores.grove.treeTypes!(OWNER);
  const type = treeTypes[0]?.id;
  assert.ok(type, 'no tree types are seeded, so no plan can name one');

  console.log('[1/5] the planner\'s tool proposes a plan, and the grove is untouched');
  const tools = createGroveTools({ stores: stores.grove });
  const before = (await db.getTrees()).length;
  const proposed = await tools['propose_plan']!({
    name: 'propose_plan',
    driver: undefined,
    caller: { ownerId: OWNER, runId: `run-${conversationId}`, agentSlug: 'planner', conversationId },
    parsed: {
      tree: { name: `Plan adoption ${conversationId}`, type, goal: 'Prove adoption end to end' },
      planDoc: '# Plan adoption proof\n\n## Destination\nhello.txt and bye.txt exist.\n\n## Not yet specified\nNone\n\n## Out of scope\nNone',
      branches: [{
        title: 'Proof',
        leaves: [
          {
            key: 'hello', title: 'Hello file', body: 'hello.txt exists and says hello', brief: 'Write hello.txt at the repo root.',
            tasks: [{ key: 'write', title: 'Write it', description: 'Create hello.txt containing hello', role: 'The thing the judge reads', doneMeans: 'cat hello.txt prints hello' }],
          },
          { key: 'bye', title: 'Bye file', body: 'bye.txt exists', brief: 'After hello.', dependsOn: ['hello'], tasks: [] },
        ],
      }],
    },
  });
  assert.equal(proposed.ok, true, proposed.digest);
  const [proposal] = await db.getPlanProposals(OWNER, conversationId) as PlanProposal[];
  assert.ok(proposal, 'the proposal was not saved');
  assert.equal(proposal.status, 'proposed');
  assert.equal((await db.getTrees()).length, before, 'a tree was created before approval');

  const adoption = createPlanAdoption({
    stores: {
      proposals: { get: (ownerId, id) => db.getPlanProposal(ownerId, id), save: (entry) => db.savePlanProposal(entry) },
      trees: { list: () => db.getTrees(), save: (tree) => db.saveTree(tree) },
      branches: { save: (branch) => db.saveBranch(branch) },
      leaves: { save: (leaf) => db.saveLeaf(leaf) },
      tasks: { save: (task) => db.saveTask(task) },
    },
    treeWorkspaces: host.treeWorkspaces,
    environments: host.environments,
  });

  let treeId: string | undefined;
  try {
    console.log('[2/5] adoption builds the grove records');
    const records = await adoption.records(OWNER, proposal.id);
    treeId = records.adopted.treeId;
    const leaves = (await db.getLeaves()).filter((leaf) => Object.values(records.adopted.leafIds).includes(leaf.id));
    assert.equal(leaves.length, 2);
    assert.ok(leaves.every((leaf) => leaf.status === 'pending'));
    const tasks = (await db.getTasks(OWNER)).filter((task) => task.leafId === records.adopted.leafIds.hello);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, 'accepted');

    console.log('[3/5] adoption writes PLAN.md and the leaf briefs into the tree sandbox and commits them');
    const commit = await adoption.documents(OWNER, proposal.id, records);
    assert.match(commit, /^[0-9a-f]{40}$/);
    await adoption.settle(OWNER, proposal.id, { status: 'adopted', adopted: { ...records.adopted, commit } });
    assert.equal((await db.getPlanProposal(OWNER, proposal.id))?.status, 'adopted');
    assert.equal(await host.treeWorkspaces.state(treeId), 'parked');

    console.log('[4/5] a later run on the tree reads them back from a fresh pod');
    const shared = await host.treeWorkspaces.describe({ treeId, ownerId: OWNER });
    const reader = await host.environments.forRun({
      ticket: { runId: `reader-${conversationId}`, depth: 1, ownerId: OWNER, agentSlug: 'leaf-executor', trigger: 'agent' },
      environment: { id: shared.id, spec: shared.capabilities, workspace: shared.workspace },
    });
    assert.ok(reader);
    const plan = await reader.exec({ command: 'cat /work/repo/PLAN.md' });
    assert.match(plan.stdout, /## The grove: Plan adoption/);
    const brief = await reader.exec({ command: `cat /work/repo/leaves/${records.adopted.leafIds.hello}.md` });
    assert.match(brief.stdout, /## The goal the judge checks\n\nhello.txt exists and says hello/);
    const log = await reader.exec({ command: 'cd /work/repo && git log --format=%H%x20%s -1' });
    assert.equal(log.stdout.trim(), `${commit} plan: ${proposal.id}`);

    if (process.env.WAIT_FOR_BACKSTOP === '1') {
      console.log('[5a] waiting out one legacy backstop cycle: the old leaf pipeline must leave the adopted leaves alone');
      const deadline = Date.now() + 330_000;
      while (Date.now() < deadline) {
        const touched = (await db.getLeaves()).filter((leaf) => Object.values(records.adopted.leafIds).includes(leaf.id) && (leaf.workflowId || leaf.status !== 'pending'));
        assert.deepEqual(touched.map((leaf) => leaf.id), [], 'the legacy pipeline started an engine leaf');
        await new Promise((done) => setTimeout(done, 10_000));
      }
    }

    console.log('[5/5] releasing the tree removes its sandbox');
    await host.treeWorkspaces.release(treeId);
    console.log('\nplan adoption: proposal kept until approval, grove built, documents committed in the tree sandbox and read back — PASS');
  } finally {
    if (treeId) {
      await host.treeWorkspaces.release(treeId).catch(() => undefined);
      const branchIds = (await db.getBranches()).filter((branch) => branch.treeId === treeId).map((branch) => branch.id);
      for (const leaf of (await db.getLeaves()).filter((entry) => branchIds.includes(entry.branchId))) await db.deleteLeaf(leaf.id);
      for (const task of (await db.getTasks(OWNER))) await db.deleteTask(task.id);
      for (const id of branchIds) await db.deleteBranch(id);
      await db.deleteTree(treeId);
    }
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
