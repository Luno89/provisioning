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
import { conversationConclusionId } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';

const QUIET_MS = DEFAULT_CONCLUDE_AFTER_MINUTES * 60_000;

const BASE = process.env.MEMORY_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.MEMORY_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
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

interface Trace { kind: string; finish?: { outcome: string }; outputs?: { text?: string; content?: string; memories?: { title: string; text: string }[]; results?: { name: string; ok: boolean; digest: string }[] } }

const traces = async (http: AxiosInstance, runId: string): Promise<Trace[]> =>
  ((await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[]) ?? [];

const finished = (http: AxiosInstance, runId: string, limitMs = 15 * 60_000) =>
  until(`run ${runId} to finish`, limitMs, async () => {
    const found = await traces(http, runId).catch(() => []);
    return found.some((trace) => trace.finish && trace.kind === 'finish') ? found : undefined;
  });

const touched = new Set<string>();

async function chat(http: AxiosInstance, conversationId: string, message: string): Promise<{ runId: string; traces: Trace[] }> {
  const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
  touched.add(runId);
  console.log(`  koala run ${runId}`);
  return { runId, traces: await finished(http, runId) };
}

async function main(): Promise<void> {
  assert.ok(OWNER, 'set MEMORY_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the runs use');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });

  const marker = `heron-${Date.now().toString(36)}`;
  const fact = `Quick background before we start next week: our team's release codeword is ${marker} — whenever we say it, it means the release is cleared to ship. No need to do anything yet.`;
  const conversations: string[] = [];
  try {
    console.log('[1/5] a chat mentions something worth remembering');
    const first = (await http.post('/conversations', {})).data.id as string;
    conversations.push(first);
    await chat(http, first, fact);
    const client = await getTemporalClient();
    const timer = await client.workflow.getHandle(conversationConclusionId(first)).describe();
    console.log(`  the conversation's countdown is ${timer.status.name}`);
    assert.equal(timer.status.name, 'RUNNING', 'no countdown started when the turn ended');

    console.log('[2/5] five minutes later another message arrives, which starts the count again');
    await sleep(5 * 60_000);
    await chat(http, first, 'One more thing for later: we never deploy on Fridays.');
    const secondEnded = Date.now();
    const keeperRunId = async () => `memory-conversation-${first}-${(await db.getConversation(OWNER, first))?.messages.length ?? 0}`;
    const startedAt = async (id: string) => {
      const found = await traces(http, id).catch(() => []);
      return found.length > 0 ? found : undefined;
    };

    console.log(`[3/5] nothing concludes ${QUIET_MS / 60_000} minutes after the first message`);
    await sleep(Math.max(0, QUIET_MS - 5 * 60_000 + 60_000));
    assert.equal(await startedAt(await keeperRunId()), undefined, 'it concluded on the first message\'s countdown, ignoring the newer one');

    console.log(`[4/5] ${QUIET_MS / 60_000} quiet minutes after the last turn, the memory keeper runs`);
    const keeperRun = await until('the memory keeper to start on that conversation', QUIET_MS + 5 * 60_000, async () => {
      const id = await keeperRunId();
      return (await startedAt(id)) ? id : undefined;
    });
    const waited = Date.now() - secondEnded;
    console.log(`  it started ${(waited / 60_000).toFixed(1)} minutes after the last turn ended`);
    assert.ok(waited >= QUIET_MS - 30_000, 'it started before the quiet time had passed since the last turn');
    console.log(`  memory keeper run ${keeperRun}`);
    touched.add(keeperRun);
    const kept = await finished(http, keeperRun);
    const calls = kept.filter((trace) => trace.kind === 'run-tool-calls').flatMap((trace) => trace.outputs?.results ?? []);
    console.log(`  it called: ${calls.map((call) => `${call.name}${call.ok ? '' : ' (refused)'} — ${call.digest}`).join('; ') || 'nothing'}`);
    assert.equal(kept.find((trace) => trace.kind === 'finish' && trace.finish)?.finish?.outcome, 'ok', 'the memory keeper did not finish ok');

    console.log('[5/5] the memory bank holds it, and a new chat recalls it');
    const remembered = (await db.getMemories(OWNER)).filter((memory) => !memory.invalidAt && `${memory.title} ${memory.text}`.includes(marker));
    assert.ok(remembered.length > 0, `nothing remembered mentions ${marker}`);
    for (const memory of remembered) console.log(`  ${memory.id} [${memory.category}, ${memory.scope}] ${memory.title}: ${memory.text} (saved by ${memory.provenance?.experimentId ?? memory.source})`);

    const second = (await http.post('/conversations', {})).data.id as string;
    conversations.push(second);
    const asked = await chat(http, second, 'What is our team\'s release codeword? Just the word.');
    const recalled = asked.traces.some((trace) => trace.kind === 'recall-memory' && (trace.outputs?.memories ?? []).some((memory) => `${memory.title} ${memory.text}`.includes(marker)));
    const answer = String([...asked.traces].reverse().find((trace) => trace.kind === 'call-model')?.outputs?.content ?? '');
    console.log(`  recalled into the prompt: ${recalled}; answer: ${answer.trim().slice(0, 200)}`);
    assert.ok(recalled, 'the memory was not recalled into the new chat');
    assert.ok(answer.includes(marker), 'koala did not answer from what it remembered');

    for (const memory of remembered) await db.saveMemory({ ...memory, invalidAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    console.log('memory live — PASS');
  } finally {
    for (const id of conversations) await http.delete(`/conversations/${id}`).catch(() => undefined);
    console.log(`  forgot ${await forgetWhatRunsLeft(db, OWNER, touched)} things the test's own runs left behind`);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
