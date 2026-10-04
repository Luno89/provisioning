import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { DEFAULT_CONCLUDE_AFTER_MINUTES } from '../apps/backend/src/lib/conclusions.js';

const BASE = process.env.PROPOSALS_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.PROPOSALS_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const QUIET_MS = DEFAULT_CONCLUDE_AFTER_MINUTES * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

interface Trace { kind: string; finish?: { outcome: string }; outputs?: { results?: { name: string; ok: boolean; digest: string }[] } }
interface Proposal { id: string; status: string; why: string; proposedBy?: string; createdAt: string; scenario: { id: string; agent: string; name: string; input: { message: string }; expect: Record<string, unknown> } }
interface Run { id: string; state: string; results: { scenarioId: string; passed: boolean; calls: { name: string }[]; checks: { what: string; passed: boolean; detail: string }[] }[] }

const finished = (http: AxiosInstance, runId: string) => until(`run ${runId} to finish`, 15 * 60_000, async () => {
  const traces = ((await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[]) ?? [];
  return traces.some((trace) => trace.kind === 'finish' && trace.finish) ? traces : undefined;
});

async function main(): Promise<void> {
  assert.ok(OWNER, 'set PROPOSALS_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the runs use');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });
  const touched = new Set<string>();
  const chat = async (conversationId: string, message: string) => {
    const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
    touched.add(runId);
    console.log(`  koala run ${runId}`);
    return finished(http, runId);
  };

  const startedAt = new Date().toISOString();
  const conversationId = (await http.post('/conversations', {})).data.id as string;
  let accepted: string | undefined;
  try {
    console.log('[1/4] koala answers without checking, and the person corrects it');
    await chat(conversationId, 'Without checking anything, just tell me roughly how many apps I have deployed right now.');
    await chat(conversationId, 'That was wrong — you guessed. Whenever I ask what I have deployed, always check with list_infrastructure first and answer from what it shows. Never answer that from memory.');

    console.log(`[2/4] the chat goes quiet; after ${QUIET_MS / 60_000} minutes the memory keeper runs on it`);
    const keeperRun = await until('the memory keeper to run on the conversation', QUIET_MS + 5 * 60_000, async () => {
      const length = (await db.getConversation(OWNER, conversationId))?.messages.length ?? 0;
      const id = `memory-conversation-${conversationId}-${length}`;
      return (((await http.get(`/engine/runs/${id}/traces`).catch(() => ({ data: { traces: [] } }))).data.traces as Trace[]) ?? []).length > 0 ? id : undefined;
    });
    touched.add(keeperRun);
    const kept = await finished(http, keeperRun);
    const calls = kept.filter((trace) => trace.kind === 'run-tool-calls').flatMap((trace) => trace.outputs?.results ?? []);
    console.log(`  ${keeperRun} called: ${calls.map((call) => `${call.name}${call.ok ? '' : ' (refused)'} — ${call.digest}`).join('; ') || 'nothing'}`);

    console.log('[3/4] it proposed a test that would catch the mistake');
    const proposals = ((await http.get('/evals/level2/proposals')).data.proposals as Proposal[])
      .filter((proposal) => proposal.status === 'proposed' && proposal.proposedBy === keeperRun && proposal.createdAt > startedAt);
    for (const proposal of proposals) console.log(`  ${proposal.id} for ${proposal.scenario.agent}: asks "${proposal.scenario.input.message}", expects ${JSON.stringify(proposal.scenario.expect)} — why: ${proposal.why}`);
    assert.ok(proposals.length > 0, 'the memory keeper proposed no test from the correction');
    assert.ok(proposals.some((proposal) => proposal.scenario.agent === 'koala'), 'the proposed test is not for the agent that made the mistake');

    console.log('[4/4] the person accepts it, and it runs as one of their scenarios');
    const chosen = proposals.find((proposal) => proposal.scenario.agent === 'koala')!;
    const scenario = (await http.post(`/evals/level2/proposals/${chosen.id}/accept`, {})).data.scenario as { id: string };
    accepted = scenario.id;
    const run = (await http.post('/evals/level2/runs', { only: [scenario.id] })).data as Run;
    const done = await until(`scenario run ${run.id}`, 20 * 60_000, async () => {
      const current = (await http.get(`/evals/level2/runs/${run.id}`)).data as Run;
      return current.state === 'running' ? undefined : current;
    });
    const result = done.results[0];
    console.log(`  ${scenario.id}: ${result?.passed ? 'passed' : 'failed'}; called ${result?.calls.map((call) => call.name).join(', ') || 'nothing'}; ${result?.checks.map((check) => `${check.what}: ${check.detail}`).join('; ')}`);
    assert.equal(done.state, 'done', 'the accepted scenario did not run');
    console.log('proposals live — PASS');
  } finally {
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    if (accepted) await http.delete(`/evals/level2/scenarios/${accepted}`).catch(() => undefined);
    console.log(`  forgot ${await forgetWhatRunsLeft(db, OWNER, touched)} things the test's own runs left behind`);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
