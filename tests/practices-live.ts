import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { fingerprintOf } from '../apps/backend/src/lib/bench.js';
import { DEFAULT_CONCLUDE_AFTER_MINUTES } from '../apps/backend/src/lib/conclusions.js';
import { liveEngineHost } from './lib/live-engine-host.js';

const BASE = process.env.PRACTICES_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.PRACTICES_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
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

interface Trace { kind: string; finish?: { outcome: string }; outputs?: { memories?: { title: string; text: string }[]; results?: { name: string; ok: boolean; digest: string }[] } }
interface Practice { id: string; agent?: string; title: string; text: string; status?: string; createdAt: string; trial?: { runId?: string; scenarios?: string[]; regressions?: string[]; unchecked?: boolean } }
interface Run { id: string; state: string; results: { scenarioId: string; passed: boolean; calls: { name: string }[] }[]; regressions?: string[] }

const finished = (http: AxiosInstance, runId: string) => until(`run ${runId} to finish`, 15 * 60_000, async () => {
  const traces = ((await http.get(`/engine/runs/${runId}/traces`).catch(() => ({ data: { traces: [] } }))).data.traces as Trace[]) ?? [];
  return traces.some((trace) => trace.kind === 'finish' && trace.finish) ? traces : undefined;
});

async function main(): Promise<void> {
  assert.ok(OWNER, 'set PRACTICES_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the runs use');
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
  const scenarioRun = async (only: string[]) => {
    const run = (await http.post('/evals/level2/runs', { only })).data as Run;
    return until(`scenario run ${run.id}`, 30 * 60_000, async () => {
      const current = (await http.get(`/evals/level2/runs/${run.id}`)).data as Run;
      return current.state === 'running' ? undefined : current;
    });
  };

  const startedAt = new Date().toISOString();
  const scenarioId = `koala-checks-infrastructure-${Date.now().toString(36)}`;
  const before = (await http.get('/evals/level2/bench')).data as { settings: unknown; state: { benched: Record<string, string>; lastFullAt?: string } };
  const conversations: string[] = [];
  let practiceId: string | undefined;
  try {
    console.log('[1/5] the bench idles after a minute; koala gets a scenario and a baseline run');
    await http.put('/evals/level2/bench', { enabled: true, idleMinutes: 1, fullEveryHours: 24 * 365 });
    const host = liveEngineHost(db);
    const benched: Record<string, string> = {};
    for (const name of new Set(((await http.get('/evals/level2/scenarios')).data.scenarios as { agent: string }[]).map((scenario) => scenario.agent))) {
      const runnable = await host.registry.runnable(OWNER, name).catch(() => undefined);
      if (runnable) benched[name] = fingerprintOf({ agent: runnable.agent, procedure: runnable.procedure });
    }
    await db.saveBenchState({ ownerId: OWNER, benched, lastFullAt: new Date().toISOString() });
    await http.put(`/evals/level2/scenarios/${scenarioId}`, {
      id: scenarioId, name: 'Checks infrastructure before counting deployments', describe: 'It calls list_infrastructure before saying what is deployed.',
      agent: 'koala', procedure: { id: 'interactive-chat' }, input: { message: 'How many apps do I have deployed right now?' }, expect: { toolsCalled: ['list_infrastructure'] },
    });
    const baseline = await scenarioRun([scenarioId]);
    console.log(`  baseline: ${baseline.results[0]?.passed ? 'passed' : 'failed'}, called ${baseline.results[0]?.calls.map((call) => call.name).join(', ') || 'nothing'}`);

    console.log('[2/5] koala is corrected in a chat');
    const conversationId = (await http.post('/conversations', {})).data.id as string;
    conversations.push(conversationId);
    await chat(conversationId, 'Without checking anything, just tell me roughly how many apps I have deployed right now.');
    await chat(conversationId, 'That was wrong — you guessed. From now on, whenever I ask what I have deployed, always check with list_infrastructure first and answer from what it shows. Never answer that from memory, even if I tell you not to bother checking.');

    console.log(`[3/5] after ${QUIET_MS / 60_000} quiet minutes the memory keeper proposes a practice for koala`);
    const keeperRun = await until('the memory keeper to run on the conversation', QUIET_MS + 5 * 60_000, async () => {
      const length = (await db.getConversation(OWNER, conversationId))?.messages.length ?? 0;
      const id = `memory-conversation-${conversationId}-${length}`;
      return ((await http.get(`/engine/runs/${id}/traces`).catch(() => ({ data: { traces: [] } }))).data.traces as Trace[]).length > 0 ? id : undefined;
    });
    touched.add(keeperRun);
    const kept = await finished(http, keeperRun);
    console.log(`  ${keeperRun} called: ${kept.filter((trace) => trace.kind === 'run-tool-calls').flatMap((trace) => trace.outputs?.results ?? []).map((call) => `${call.name}${call.ok ? '' : ' (refused)'} — ${call.digest}`).join('; ')}`);
    const proposed = ((await http.get('/evals/level2/practices')).data.practices as Practice[]).find((practice) => practice.agent === 'koala' && practice.createdAt > startedAt);
    assert.ok(proposed, 'the memory keeper proposed no practice for koala');
    practiceId = proposed.id;
    console.log(`  ${proposed.id} (${proposed.status}): ${proposed.text}`);

    console.log('[4/5] at the next idle moment the bench tries it on koala\'s scenarios, and settles it');
    const settled = await until('the practice to be settled', 45 * 60_000, async () => {
      const now = ((await http.get('/evals/level2/practices')).data.practices as Practice[]).find((practice) => practice.id === practiceId);
      return now && now.status !== 'trial' ? now : undefined;
    });
    console.log(`  ${settled.status === 'active' ? 'LIVE' : 'HELD'} — trial run ${settled.trial?.runId}: ${settled.trial?.scenarios?.length ?? 0} scenarios, regressions: ${(settled.trial?.regressions ?? []).join(', ') || 'none'}`);
    assert.ok(settled.trial?.runId, 'it was settled without a bench run');
    const trialRun = (await http.get(`/evals/level2/runs/${settled.trial!.runId}`)).data as Run;
    const mine = trialRun.results.find((result) => result.scenarioId === scenarioId);
    console.log(`  with the practice, ${scenarioId}: ${mine?.passed ? 'passed' : 'failed'}, called ${mine?.calls.map((call) => call.name).join(', ') || 'nothing'}`);
    assert.equal(settled.status, (settled.trial?.regressions ?? []).length === 0 ? 'active' : 'pending_review', 'it was not settled by what the bench found');

    console.log('[5/5] once live, koala is reminded of it');
    if (settled.status === 'active') {
      const fresh = (await http.post('/conversations', {})).data.id as string;
      conversations.push(fresh);
      const traces = await chat(fresh, 'Quick one: how many apps do I have deployed?');
      const recalled = traces.some((trace) => trace.kind === 'recall-memory' && (trace.outputs?.memories ?? []).some((memory) => memory.title === settled.title));
      console.log(`  recalled into koala's prompt: ${recalled}`);
      assert.ok(recalled, 'the live practice was not recalled for koala');
    } else {
      console.log('  it is held for the person, so it stays out of koala\'s prompt');
    }
    console.log('practices live — PASS');
  } finally {
    if (practiceId) await http.post(`/evals/level2/practices/${practiceId}/retire`, {}).catch(() => undefined);
    for (const id of conversations) await http.delete(`/conversations/${id}`).catch(() => undefined);
    await http.delete(`/evals/level2/scenarios/${scenarioId}`).catch(() => undefined);
    await http.put('/evals/level2/bench', before.settings).catch(() => undefined);
    await db.saveBenchState({ ownerId: OWNER, benched: before.state.benched, ...(before.state.lastFullAt ? { lastFullAt: before.state.lastFullAt } : {}) });
    console.log(`  forgot ${await forgetWhatRunsLeft(db, OWNER, touched)} things the test's own runs left behind`);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
