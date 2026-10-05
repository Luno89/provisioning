import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { BUILT_IN_GROUPS, builtInCatalogue, runProcedure } from '@koala/agent-engine/procedure';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { createProcedureExecutor } from '../apps/backend/src/engine-host/nodes/index.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { PlanService } from '../apps/backend/src/services/PlanService.js';
import { DEFAULT_ENGINE_TASK_QUEUE, groveRunWorkflowId, type AgentRunOutcome, type GroveRunResult } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { groveAgentOf, resolveTreeType } from '../apps/backend/src/lib/tree-types.js';
import { GiteaService } from '../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import axios from 'axios';
import { treeRepoName, treeWorkspaceRunId } from '../apps/backend/src/engine-host/sandboxes/tree-workspaces.js';
import { conversationRepoName } from '../apps/backend/src/engine-host/sandboxes/workspace-repos.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { WorkspaceConclusionService } from '../apps/backend/src/services/WorkspaceConclusionService.js';
import { createKubeRunner } from '../apps/backend/src/engine-host/sandboxes/kube.js';
import { workspaceName } from '../apps/backend/src/engine-host/sandboxes/workspace.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = process.env.GROVE_LIVE_OWNER;
const GOAL = process.env.GROVE_LIVE_GOAL
  ?? 'New Grove project "greeter": a tiny Node.js command-line greeter. Exactly one branch and two leaves. Leaf 1: greet.js prints "hello, <name>" for the name given as its first argument (and "hello, world" without one). Leaf 2, which waits on leaf 1: test.sh runs greet.js with and without a name and exits 0 only when both outputs are right. A couple of tasks per leaf. Use only node and sh — nothing to install.';
const DEADLINE_MS = Number(process.env.GROVE_LIVE_MINUTES ?? '60') * 60_000;
const EXPECT_STOPPED = process.env.GROVE_LIVE_EXPECT_STOPPED === '1';

const BASE = process.env.GROVE_LIVE_URL ?? 'http://localhost:3001/api';
const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
const elapsed = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;

async function main(): Promise<void> {
  assert.ok(OWNER, 'set GROVE_LIVE_OWNER to the user whose model deployment the run should use');
  const started = Date.now();
  const db = createDatabase();
  await db.init();
  const host = liveEngineHost(db);
  const client = await getTemporalClient();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');

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
  const account = await db.getGiteaAccount(OWNER);
  assert.ok(account, 'the owner has no Gitea account, so nothing was saved');
  const planNote = `planner/run-${conversationId}/plan.md`;
  const conversationRepo = conversationRepoName(conversationId);
  const noted = await gitea.getRawFile(account.username, conversationRepo, planNote, 'main');
  console.log(`      the planner wrote ${planNote} in the conversation's workspace, saved to ${account.username}/${conversationRepo}: ${noted ? `${noted.length} chars` : 'MISSING'}`);
  assert.ok(noted?.trim(), `the planner did not write ${planNote} into the conversation's workspace`);

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
  const brought = await gitea.getRawFile(account.username, treeRepoName(treeId), planNote, 'main');
  console.log(`      adoption copied ${planNote} into the tree's repository: ${brought === noted ? 'identical' : brought ? 'DIFFERENT' : 'MISSING'}`);
  assert.equal(brought, noted, `${planNote} was not copied into the tree's repository as the conversation saved it`);
  const conclusions = new WorkspaceConclusionService({ workflows: async () => client.workflow, taskQueue: queue });
  const concluded = await conclusions.conclude(OWNER, { kind: 'conversation', id: conversationId });
  console.log(`      the conversation's workspace concluded through ConcludeWorkspaceWorkflow: ${JSON.stringify(concluded)}`);
  assert.ok(concluded.saved, 'the conversation\'s workspace was not saved when it concluded');
  await gitea.deleteRepo(account.username, conversationRepo);

  console.log(`[3/4] the grove run works the tree (${elapsed(started)})`);
  const tree = (await db.getTrees()).find((entry) => entry.id === treeId);
  const groveAgent = groveAgentOf(await resolveTreeType(db, OWNER, tree?.type));
  const grower = await host.registry.runnable(OWNER, groveAgent);
  assert.ok(grower, `there is no agent called ${groveAgent} to grow the tree`);
  console.log(`      grown by ${groveAgent} on ${grower.procedure.id}`);
  const run = await client.workflow.start('AgentRunWorkflow', {
    workflowId: groveRunWorkflowId(treeId),
    taskQueue: queue,
    args: [{ ticket: { runId: groveRunWorkflowId(treeId), depth: 0, ownerId: OWNER, agentSlug: groveAgent, trigger: 'user' }, procedure: grower.procedure, inputs: { treeId, message: 'Grow the tree.' } }],
  });
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
      (run.result() as Promise<AgentRunOutcome>).then((outcome) => {
        if (outcome.outcome !== 'ok') throw new Error(`the run ended ${outcome.outcome}: ${outcome.reason ?? ''}`);
        return outcome.outputs as unknown as GroveRunResult;
      }),
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
  const heads = (await reader?.exec({ command: "cd /work/repo && git for-each-ref --format='%(refname:short) %(objectname)' refs/heads" }))?.stdout.trim().split('\n').filter(Boolean) ?? [];
  const plan = (await reader?.exec({ command: 'cat /work/repo/PLAN.md' }))?.stdout ?? '';
  const repo = treeRepoName(treeId);
  const missing: string[] = [];
  for (const head of heads) {
    const [branch, sha] = head.split(' ');
    if (!(await gitea.getCommit(account.username, repo, sha!).catch(() => null))) missing.push(branch!);
  }
  console.log(`\n  saved to Gitea ${account.username}/${repo}: ${heads.length - missing.length} of ${heads.length} branch heads${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
  assert.ok(heads.length > 0, 'the tree repository has no branches');
  assert.deepEqual(missing, [], 'the tree repository in Gitea is behind the sandbox');
  assert.equal(await gitea.getRawFile(account.username, repo, 'PLAN.md', 'main'), plan, 'PLAN.md in Gitea differs from the sandbox');

  const withCommits = leaves.filter((leaf) => leaf.claim?.commit);
  let opened = 0;
  for (const leaf of withCommits) {
    const files = leaf.claim!.files ?? [];
    console.log(`  ${leaf.title}'s page lists ${files.length} documents: ${files.join(', ')}`);
    assert.ok(files.length > 0, `${leaf.title} claimed ${leaf.claim!.commit} but its claim lists no documents`);
    for (const file of files) {
      const document = (await http.get(`/documents/${encodeURIComponent(treeWorkspaceRunId(treeId))}`, { params: { path: file, at: leaf.claim!.commit } })).data as { content: string; ref: string };
      const there = (await reader?.exec({ command: `cd /work/repo && git show ${leaf.claim!.commit}:${file}` }))?.stdout ?? '';
      assert.equal(document.content, there, `${file} opened from ${leaf.title}'s page differs from ${leaf.claim!.commit}`);
      opened += 1;
    }
  }
  console.log(`  opened ${opened} leaf documents through /api/documents, each matching its claimed commit`);
  assert.ok(withCommits.length > 0, 'no leaf claimed a commit, so no leaf documents were checked');

  console.log('  deleting the tree through /api/trees, which concludes its workspace through ConcludeWorkspaceWorkflow first');
  await http.delete(`/trees/${encodeURIComponent(treeId)}`);
  const kube = createKubeRunner();
  const namespace = workspaceName(treeWorkspaceRunId(treeId));
  const lingering = await kube(['wait', '--for=delete', `namespace/${namespace}`, '--timeout=180s'], undefined, 200_000);
  assert.ok(lingering.exitCode === 0 || /not found/i.test(lingering.stderr), `the tree's workspace ${namespace} is still there: ${lingering.stderr}`);
  const after = await client.workflow.getHandle(`conclude-workspace-tree-${treeId}`).describe();
  console.log(`  ${after.workflowId} ${after.status.name}; the workspace is gone, and Gitea still holds PLAN.md`);
  assert.equal(after.status.name, 'COMPLETED');
  assert.equal(await gitea.getRawFile(account.username, repo, 'PLAN.md', 'main'), plan, 'PLAN.md is not in Gitea after the tree was deleted');
  await gitea.deleteRepo(account.username, repo);

  if (EXPECT_STOPPED) {
    const failedTasks = tasks.filter((task) => task.status === 'failed');
    const stoppedLeaves = leaves.filter((leaf) => failedTasks.some((task) => task.leafId === leaf.id));
    const judgeRuns = (await db.getRunEffort(OWNER, 'tool-rounds'))
      .filter((effort) => effort.agentSlug === 'leaf-judge' && effort.runId.startsWith(groveRunWorkflowId(treeId)))
      .map((effort) => effort.runId);
    const judgeTraces = (await Promise.all(judgeRuns.map((runId) => db.getRunTraces(OWNER, runId)))).flat();
    const readRuns = judgeTraces
      .filter((trace) => trace.kind === 'run-tool-calls')
      .flatMap((trace) => (trace.outputs as { results?: { name: string; ok: boolean }[] } | undefined)?.results ?? [])
      .filter((call) => call.name === 'read_run' && call.ok);
    console.log(`\n  stopped: ${failedTasks.length} failed tasks on ${stoppedLeaves.length} leaves; ${judgeRuns.length} judge runs made ${readRuns.length} read_run calls`);
    await db.close();
    assert.ok(failedTasks.length > 0, 'no task failed, so this run did not exercise a stopped leaf');
    for (const leaf of stoppedLeaves) {
      assert.ok(leaf.claim?.evidence.includes('[failed]'), `${leaf.title} was not claimed with its failed task in the evidence`);
      assert.equal(leaf.review?.model, 'leaf-judge', `${leaf.title} was settled by ${leaf.review?.model ?? 'nobody'}, not its judge`);
    }
    assert.ok(readRuns.length > 0, 'the judge never read the run that failed');
  } else {
    await db.close();
  }

  if (!result) process.exit(1);
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
