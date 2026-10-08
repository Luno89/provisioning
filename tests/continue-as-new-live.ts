import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { startedFor } from '../apps/backend/src/lib/workflow-owner.js';
import { DEFAULT_ENGINE_TASK_QUEUE, type AgentRunOutcome, type ProcedureRunInput } from '../apps/backend/src/engine-host/temporal/contracts.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = process.env.CONTINUE_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const AGENT = process.env.CONTINUE_LIVE_AGENT ?? 'research';
const QUESTION = process.env.CONTINUE_LIVE_QUESTION ?? 'What does the `jq -r` flag do? Answer in two sentences.';
const DEADLINE_MS = Number(process.env.CONTINUE_LIVE_MINUTES ?? '20') * 60_000;
const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;

async function main(): Promise<void> {
  assert.ok(OWNER, 'set CONTINUE_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model deployment the run should use');
  const db = createDatabase();
  await db.init();
  const host = liveEngineHost(db);
  const client = await getTemporalClient();

  const runnable = await host.registry.runnable(OWNER, AGENT);
  assert.ok(runnable, `there is no agent called ${AGENT}`);
  const runId = `continue-live-${Date.now().toString(36)}`;
  const input: ProcedureRunInput = {
    ticket: { runId, depth: 0, ownerId: OWNER, agentSlug: AGENT, trigger: 'user' },
    procedure: runnable.procedure,
    inputs: { message: QUESTION },
    continueAfterEvents: 1,
  };

  console.log(`[1/3] ${AGENT} runs on the engine worker, continuing as new after every step (${runId})`);
  const handle = await client.workflow.start('AgentRunWorkflow', { workflowId: runId, taskQueue: queue, args: [input], ...startedFor(OWNER) });
  const result = await Promise.race([
    handle.result() as Promise<AgentRunOutcome>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still running after ${DEADLINE_MS / 60_000} minutes`)), DEADLINE_MS)),
  ]);

  console.log(`[2/3] it ended ${result.outcome}${result.reason ? `: ${result.reason}` : ''}`);
  const runs: string[] = [];
  for await (const execution of client.workflow.list({ query: `WorkflowId = '${runId}'` })) runs.push(`${execution.runId} ${execution.status.name}`);
  for (const line of runs) console.log(`      ${line}`);

  const traces = await db.getRunTraces(OWNER, runId);
  console.log(`[3/3] ${traces.length} node traces under ${runId}: ${traces.map((trace) => trace.kind).join(' → ')}`);
  console.log(`      answer: ${JSON.stringify(result.outputs).slice(0, 400)}`);

  assert.equal(result.outcome, 'ok', 'the run did not end ok');
  assert.ok(runs.filter((line) => line.endsWith('CONTINUED_AS_NEW')).length >= 1, 'the run never continued as new');
  assert.equal(runs.filter((line) => line.endsWith('COMPLETED')).length, 1, 'exactly one execution should have completed');
  assert.ok(traces.some((trace) => trace.kind === 'finish'), 'the finish node was not traced under the run');
  assert.equal(traces.filter((trace) => trace.kind === 'provision-sandbox').length, 1, 'the run started over instead of resuming');
  assert.equal(traces.filter((trace) => trace.kind === 'release-sandbox').length, 1, 'cleanup ran more than once');
  console.log('passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
