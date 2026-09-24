import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { BUILT_IN_GROUPS, builtInCatalogue, runProcedure } from '@koala/agent-engine/procedure';
import { createEventBus } from '@koala/agent-engine/workflow';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { createModelService } from '../apps/backend/src/lib/model-wiring.js';
import { createEngineHost, storesFromDatabase } from '../apps/backend/src/engine-host/host.js';
import { createProcedureExecutor } from '../apps/backend/src/engine-host/nodes/index.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = process.env.PLANNER_LIVE_OWNER ?? 'planner-live';
const GOAL = process.env.PLANNER_LIVE_GOAL
  ?? 'New Grove project: a tiny static "hello" web page served by nginx. Keep it deliberately small: exactly one branch, two leaves — (1) write the page, (2) serve it with nginx — with a couple of tasks under each leaf.';

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const host = createEngineHost({
    models: createModelService(db, process.env.JWT_SECRET ?? ''),
    stores: storesFromDatabase(db),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
  });

  const runnable = await host.registry.runnable(OWNER, 'planner');
  assert.ok(runnable, 'there is no planner');
  const conversationId = `planner-live-${Date.now().toString(36)}`;
  const runId = `run-${conversationId}`;

  const bus = createEventBus({ retain: 0 });
  bus.subscribe((event) => {
    const e = event as unknown as Record<string, unknown>;
    if (e.type === 'tool.called') {
      const args = (() => { try { return JSON.parse(String(e.args)) as Record<string, unknown>; } catch { return {}; } })();
      const shape = Object.entries(args).map(([key, value]) => `${key}:${Array.isArray(value) ? 'array' : typeof value}`).join(' ');
      console.log(`→ ${String(e.name)} {${shape}}`);
      if (typeof args.branches === 'string') {
        const text = args.branches;
        let why = 'parses';
        try { JSON.parse(text); } catch (err) { why = (err as Error).message; }
        console.log(`  branches text (${text.length} chars, ${why}): ${JSON.stringify(text.slice(0, 160))} … ${JSON.stringify(text.slice(-160))}`);
      }
    }
    if (e.type === 'tool.result') console.log(`← ${e.ok ? 'ok' : 'REFUSED'}: ${String(e.digest).slice(0, 600)}`);
    if (e.type === 'run.finished') console.log(`run finished: ${String(e.outcome)} ${String(e.reason ?? '')}`);
  });

  const result = await runProcedure({
    procedure: runnable.procedure,
    catalogue: builtInCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor: createProcedureExecutor(host.services, { registry: host.registry }),
    identity: { runId, depth: 0, agentId: 'planner', loopId: runnable.procedure.id, loopVersion: runnable.procedure.version, trigger: 'user' },
    launch: { ownerId: OWNER, conversationId },
    inputs: { goal: GOAL, message: GOAL },
    budget: runnable.procedure.budget,
    bus,
  });

  const proposals = await db.getPlanProposals(OWNER, conversationId);
  console.log(`\noutcome ${result.outcome}${result.reason ? ` (${result.reason})` : ''}; proposals: ${proposals.length}`);
  await db.close();
  assert.equal(result.outcome, 'ok');
  const open = proposals.filter((proposal) => proposal.status === 'proposed');
  assert.equal(open.length, 1, `the planner should leave exactly one plan waiting for approval, left ${open.length}`);
  assert.ok(open[0]!.plan.branches.some((branch) => branch.leaves.some((leaf) => leaf.tasks.length > 0)), 'the open plan has no tasks');
  for (const branch of open[0]!.plan.branches) {
    for (const leaf of branch.leaves) console.log(`  leaf ${leaf.key}: ${leaf.title}${leaf.dependsOn.length ? ` (after ${leaf.dependsOn.join(', ')})` : ''} — ${leaf.tasks.length} tasks`);
  }
  const fog = /^#{1,3}\s*Not yet specified\s*$([\s\S]*?)(^#{1,3}\s|$(?![\s\S]))/im.exec(open[0]!.plan.planDoc)?.[1]?.trim();
  console.log(`  not yet specified: ${fog ?? '(missing)'}`);
  console.log('planner live: the real model proposed a plan through the real tool gate — PASS');
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
