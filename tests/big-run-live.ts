import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { leaseMongo } from '../apps/backend/src/platform/lib/mongo-lease.js';
import { temporal } from '@temporalio/proto';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { databaseSettingsFrom } from '../apps/backend/src/platform/lib/settings.js';
import { mongoTarget } from '../apps/backend/src/platform/lib/mongo-db.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { connectTemporalAs, getTemporalClient } from '../apps/backend/src/platform/lib/temporal-client.js';
import { keepPayloadsIn } from '../apps/backend/src/platform/lib/db-interface.js';
import { connectionSettingsFrom } from '../apps/backend/src/platform/lib/settings.js';
import { startedFor } from '../apps/backend/src/platform/lib/workflow-owner.js';
import { DEFAULT_ENGINE_TASK_QUEUE, type AgentRunOutcome, type ProcedureRunInput } from '../apps/backend/src/engine-host/temporal/contracts.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname, quiet: true });
const connections = connectionSettingsFrom(process.env);
connectTemporalAs(connections);
keepPayloadsIn(connections.mongo);

const OWNER = process.env.BIG_RUN_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const AGENT = process.env.BIG_RUN_LIVE_AGENT ?? 'research';
const QUESTION = process.env.BIG_RUN_LIVE_QUESTION ?? [
  'Read each of these pages in full, not just their summaries, then compare how each project handles failure and retries:',
  'https://en.wikipedia.org/wiki/Kubernetes',
  'https://en.wikipedia.org/wiki/Apache_Kafka',
  'https://en.wikipedia.org/wiki/PostgreSQL',
  'https://en.wikipedia.org/wiki/Erlang_(programming_language)',
  'Quote at least one sentence from each page.',
].join('\n');
const EVENT_LIMIT = 512 * 1024;
const queue = DEFAULT_ENGINE_TASK_QUEUE;

async function main(): Promise<void> {
  assert.ok(OWNER, 'set BIG_RUN_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model deployment the run should use');
  const db = createDatabase(databaseSettingsFrom(process.env));
  await db.init();
  const host = await liveEngineHost(db);
  const client = await getTemporalClient();

  const runnable = await host.registry.runnable(OWNER, AGENT);
  assert.ok(runnable, `there is no agent called ${AGENT}`);
  const runId = `big-run-live-${Date.now().toString(36)}`;
  const input: ProcedureRunInput = {
    ticket: { runId, depth: 0, ownerId: OWNER, agentSlug: AGENT, trigger: 'user' },
    procedure: runnable.procedure,
    inputs: { message: QUESTION },
    continueAfterEvents: 1,
  };

  console.log(`[1/4] ${AGENT} reads long pages on the engine worker, continuing as new after every step (${runId})`);
  const handle = await client.workflow.start('AgentRunWorkflow', { workflowId: runId, taskQueue: queue, args: [input], ...startedFor(OWNER) });
  const result = await (handle.result() as Promise<AgentRunOutcome>);
  console.log(`[2/4] it ended ${result.outcome}${result.reason ? `: ${result.reason}` : ''}`);

  const runs: string[] = [];
  for await (const execution of client.workflow.list({ query: `WorkflowId = '${runId}'` })) runs.push(execution.runId);
  let largest = 0;
  let events = 0;
  for (const run of runs) {
    const history = await client.workflow.getHandle(runId, run).fetchHistory();
    for (const event of history.events ?? []) {
      events += 1;
      largest = Math.max(largest, temporal.api.history.v1.HistoryEvent.encode(event).finish().length);
    }
  }
  console.log(`[3/4] ${runs.length} executions, ${events} events, the largest ${(largest / 1024).toFixed(0)} KB`);

  const { uri, dbName } = mongoTarget(process.env);
  const mongo = await leaseMongo(uri);
  const [stored] = await mongo.client.db(dbName).collection('temporal_payload_chunks').aggregate<{ chunks: number; bytes: number; largest: number }>([
    { $match: { workflowId: runId } },
    { $group: { _id: null, chunks: { $sum: 1 }, bytes: { $sum: { $binarySize: '$data' } }, largest: { $max: { $binarySize: '$data' } } } },
  ]).toArray();
  await mongo.release();
  console.log(`[4/4] stored outside Temporal: ${stored?.chunks ?? 0} payloads, ${((stored?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB in all, the largest ${((stored?.largest ?? 0) / 1024).toFixed(0)} KB`);
  console.log(`      answer: ${JSON.stringify(result.outputs).slice(0, 300)}`);

  assert.equal(result.outcome, 'ok', 'the run did not end ok');
  assert.ok(runs.length > 1, 'the run never continued as new');
  assert.ok(largest < EVENT_LIMIT, `an event in the run's history is ${largest} bytes; big payloads should be stored outside Temporal`);
  assert.ok((stored?.chunks ?? 0) > 0, 'nothing was stored outside Temporal, so the run never carried anything large');
  console.log('passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
