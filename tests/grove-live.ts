import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { BUILT_IN_GROUPS, builtInCatalogue, runProcedure } from '@koala/agent-engine/procedure';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { createProcedureExecutor } from '../apps/backend/src/engine-host/nodes/index.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { PlanService } from '../apps/backend/src/services/PlanService.js';
import { DEFAULT_ENGINE_TASK_QUEUE, type GroveRunResult } from '../apps/backend/src/engine-host/temporal/contracts.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = process.env.GROVE_LIVE_OWNER;
const GOAL = process.env.GROVE_LIVE_GOAL
  ?? 'New Grove project "greeter": a tiny Node.js command-line greeter. Exactly one branch and two leaves. Leaf 1: greet.js prints "hello, <name>" for the name given as its first argument (and "hello, world" without one). Leaf 2, which waits on leaf 1: test.sh runs greet.js with and without a name and exits 0 only when both outputs are right. A couple of tasks per leaf. Use only node and sh — nothing to install.';
const DEADLINE_MS = Number(process.env.GROVE_LIVE_MINUTES ?? '60') * 60_000;

const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
const elapsed = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;

async function main(): Promise<void> {
  assert.ok(OWNER, 'set GROVE_LIVE_OWNER to the user whose model deployment the run should use');
  const started = Date.now();
  const db = createDatabase();
  await db.init();
  const host = liveEngineHost(db);
  const client = await getTemporalClient();

  console.log(`[1/4] the planner proposes (${elapsed(started)})`);
  const runnable = await host.registry.runnable(OWNER, 'planner');
  assert.ok(runnable, 'there is no planner');
  const conversationId = `grove-live-${Date.now().toString(36)}`;
  const planned = await runProcedure({
    procedure: runnable.procedure,
    catalogue: builtInCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor: createProcedureExecutor(host.services, { registry: host.registry }),
    identity: { runId: `run-${conversationId}`, depth: 0, agentId: 'planner', loopId: runnable.procedure.id, loopVersion: runnable.procedure.version, trigger: 'user' },
    launch: { ownerId: OWNER, conversationId },
    inputs: { goal: GOAL, message: GOAL },
    budget: runnable.procedure.budget,
  });
  const proposal = (await db.getPlanProposals(OWNER, conversationId)).find((entry) => entry.status === 'proposed');
  assert.ok(proposal, `the planner left no plan (${planned.outcome}${planned.reason ? `: ${planned.reason}` : ''})`);
  for (const branch of proposal.plan.branches) {
    for (const leaf of branch.leaves) console.log(`      leaf ${leaf.key}: ${leaf.title}${leaf.dependsOn.length ? ` (after ${leaf.dependsOn.join(', ')})` : ''} — ${leaf.tasks.length} tasks`);
  }

  console.log(`[2/4] approved; the plan is adopted on the engine worker (${elapsed(started)})`);
  const plans = new PlanService({
    store: db,
    adopter: {
      adoptPlan: async (ownerId, id) => {
        const handle = await client.workflow.start('AdoptPlanWorkflow', { workflowId: `adopt-plan-${id}`, taskQueue: queue, args: [{ ownerId, proposalId: id }] });
        return handle.workflowId;
      },
    },
  });
  const approved = await plans.approve(OWNER, proposal.id);
  assert.ok(approved.ok, approved.ok ? '' : approved.error);
  await client.workflow.getHandle(`adopt-plan-${proposal.id}`).result();
  const adopted = await db.getPlanProposal(OWNER, proposal.id);
  assert.equal(adopted?.status, 'adopted', `adoption ended ${adopted?.status}: ${adopted?.reason ?? ''}`);
  const treeId = adopted!.adopted!.treeId;
  const leafIds = Object.values(adopted!.adopted!.leafIds);
  console.log(`      tree ${treeId}, plan commit ${adopted!.adopted!.commit?.slice(0, 12)}`);

  console.log(`[3/4] the grove run works the tree (${elapsed(started)})`);
  const run = await client.workflow.start('GroveRunWorkflow', { workflowId: `grove-live-${treeId}`, taskQueue: queue, args: [{ treeId, ownerId: OWNER }] });
  const seen = new Map<string, string>();
  const watch = setInterval(() => {
    void db.getLeaves().then((leaves) => {
      for (const leaf of leaves.filter((entry) => leafIds.includes(entry.id))) {
        const now = `${leaf.status}${leaf.claim?.commit ? ` @${leaf.claim.commit.slice(0, 8)}` : ''}`;
        if (seen.get(leaf.id) !== now) {
          seen.set(leaf.id, now);
          console.log(`      ${elapsed(started)} ${leaf.title}: ${now}`);
        }
      }
    }).catch(() => undefined);
  }, 15_000);

  let result: GroveRunResult | undefined;
  let failure: string | undefined;
  try {
    result = await Promise.race([
      run.result() as Promise<GroveRunResult>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still running after ${DEADLINE_MS / 60_000} minutes`)), DEADLINE_MS)),
    ]);
  } catch (err) {
    failure = (err as Error).message;
  } finally {
    clearInterval(watch);
  }

  console.log(`[4/4] report (${elapsed(started)})`);
  console.log(`      run: ${result ? JSON.stringify(result) : `did not finish — ${failure}`}`);
  const leaves = (await db.getLeaves()).filter((leaf) => leafIds.includes(leaf.id));
  for (const leaf of leaves) {
    console.log(`\n  ${leaf.title} [${leaf.status}${leaf.verified ? ', verified' : ''}]`);
    if (leaf.claim) console.log(`    claim @${leaf.claim.commit ?? '(no commit)'}: ${leaf.claim.evidence.slice(0, 400)}`);
    if (leaf.review) console.log(`    ${leaf.review.model ?? 'judge'} (${leaf.review.verdict}): ${(leaf.review.reason ?? '').slice(0, 400)}`);
    if (leaf.findings) console.log(`    findings: ${leaf.findings.slice(0, 400)}`);
  }
  const tasks = (await db.getTasks(OWNER)).filter((task) => task.leafId && leafIds.includes(task.leafId));
  console.log(`\n  tasks: ${tasks.map((task) => `${task.title} [${task.status}]`).join('; ')}`);

  const shared = await host.treeWorkspaces.describe({ treeId, ownerId: OWNER });
  const reader = await host.environments.forRun({
    ticket: { runId: `grove-live-reader-${treeId}`, depth: 1, ownerId: OWNER, agentSlug: 'executor', trigger: 'agent' },
    environment: { id: shared.id, spec: shared.capabilities, workspace: shared.workspace },
  });
  const log = await reader?.exec({ command: 'cd /work/repo && git log --all --graph --oneline -20 && echo ---- && git worktree list && echo ---- && ls -R /work/trees 2>/dev/null | head -40' });
  console.log(`\n  repo:\n${log?.stdout ?? log?.stderr ?? '(unreadable)'}`);
  await host.treeWorkspaces.park(treeId);
  await db.close();

  if (!result) process.exit(1);
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
