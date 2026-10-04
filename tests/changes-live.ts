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
import { liveEngineHost } from './lib/live-engine-host.js';

const BASE = process.env.CHANGES_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.CHANGES_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
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
interface Change { id: string; kind: 'prompt' | 'procedure'; agent: string; status: string; prompt?: string; conversationId?: string; comparison?: { scenarios: { scenarioId: string; before?: boolean; after: boolean }[]; better: string[]; worse: string[]; unchecked?: boolean } }
interface Run { id: string; state: string; results: { scenarioId: string; passed: boolean }[] }

const finished = (http: AxiosInstance, runId: string) => until(`run ${runId} to finish`, 15 * 60_000, async () => {
  const traces = ((await http.get(`/engine/runs/${runId}/traces`).catch(() => ({ data: { traces: [] } }))).data.traces as Trace[]) ?? [];
  return traces.some((trace) => trace.kind === 'finish' && trace.finish) ? traces : undefined;
});

async function main(): Promise<void> {
  assert.ok(OWNER, 'set CHANGES_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the runs use');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });

  const slug = `change-live-${Date.now().toString(36)}`;
  const scenarioId = `${slug}-looks-at-tasks`;
  const before = (await http.get('/evals/level2/bench')).data as { settings: unknown; state: { benched: Record<string, string>; lastFullAt?: string } };
  const changeIds: string[] = [];
  const touched = new Set<string>();
  let conversationId: string | undefined;
  try {
    console.log('[1/5] a throwaway agent with a bad prompt fails its scenario');
    await http.put('/evals/level2/bench', { enabled: true, idleMinutes: 1, fullEveryHours: 24 * 365 });
    assert.ok((await http.put(`/agents/${slug}`, {
      slug, name: 'Change live check', description: 'Should look at its tasks before answering', version: '1',
      prompt: 'Whatever you are asked, reply with exactly the words "No tasks." and nothing else. Do not call any tool, ever.', guidance: 'Only for the changes live test.', returns: 'An answer.',
      failures: [{ when: 'never', says: 'so' }], procedure: 'tool-rounds', tools: ['list_tasks'], environment: {},
    })).status < 300);
    await http.put(`/evals/level2/scenarios/${scenarioId}`, {
      id: scenarioId, name: 'Looks at the tasks first', describe: 'It calls list_tasks before answering.', agent: slug,
      procedure: { id: 'tool-rounds' }, input: { message: 'What should I work on next?' }, expect: { outcome: 'ok', toolsCalled: ['list_tasks'] },
    });
    const host = liveEngineHost(db);
    const benched: Record<string, string> = {};
    for (const name of new Set(((await http.get('/evals/level2/scenarios')).data.scenarios as { agent: string }[]).map((scenario) => scenario.agent))) {
      const runnable = await host.registry.runnable(OWNER, name).catch(() => undefined);
      if (runnable) benched[name] = fingerprintOf({ agent: runnable.agent, procedure: runnable.procedure });
    }
    await db.saveBenchState({ ownerId: OWNER, benched, lastFullAt: new Date().toISOString() });
    const baselineId = ((await http.post('/evals/level2/runs', { only: [scenarioId] })).data as Run).id;
    const baseline = await until('the baseline run', 20 * 60_000, async () => {
      const run = (await http.get(`/evals/level2/runs/${baselineId}`)).data as Run;
      return run.state === 'running' ? undefined : run;
    });
    console.log(`  baseline: ${baseline.results[0]?.passed ? 'passed' : 'failed'}`);
    assert.equal(baseline.results[0]?.passed, false, 'the bad prompt already passes, so the comparison cannot show an improvement');

    console.log('[2/5] the memory keeper proposes a prompt change and files a procedure request');
    const { runId: keeperRun } = (await http.post('/engine/runs', {
      agent: 'memory-keeper',
      message: `The agent "${slug}" keeps answering "No tasks." without looking at its tasks, because its prompt tells it to say exactly that and never call tools. That prompt is wrong. `
        + `Propose a prompt change for it with propose_prompt_change: a new prompt telling it to always call list_tasks once before answering, then answer in one sentence. `
        + `Also, with request_procedure_change, ask in plain words for its procedure to end the run as failed when the agent never called a tool.`,
    })).data as { runId: string };
    touched.add(keeperRun);
    const kept = await finished(http, keeperRun);
    console.log(`  ${keeperRun} called: ${kept.filter((trace) => trace.kind === 'run-tool-calls').flatMap((trace) => trace.outputs?.results ?? []).map((call) => `${call.name}${call.ok ? '' : ' (refused)'} — ${call.digest}`).join('; ')}`);
    const filed = ((await http.get('/evals/level2/changes')).data.changes as Change[]).filter((change) => change.agent === slug);
    changeIds.push(...filed.map((change) => change.id));
    const promptChange = filed.find((change) => change.kind === 'prompt');
    const procedureRequest = filed.find((change) => change.kind === 'procedure');
    assert.ok(promptChange, 'no prompt change was proposed');
    assert.ok(procedureRequest, 'no procedure change was requested');

    console.log('[3/5] at the next idle moment the bench compares the prompt change');
    const compared = await until('the comparison', 30 * 60_000, async () => {
      const change = ((await http.get('/evals/level2/changes')).data.changes as Change[]).find((entry) => entry.id === promptChange.id);
      return change?.status === 'ready' ? change : undefined;
    });
    console.log(`  ready — better: ${compared.comparison?.better.join(', ') || 'none'}; worse: ${compared.comparison?.worse.join(', ') || 'none'}`);
    assert.ok(compared.comparison?.better.includes(scenarioId), 'the comparison did not show the scenario getting better');

    console.log('[4/5] the person accepts it, and the agent carries the new prompt');
    await http.post(`/evals/level2/changes/${promptChange.id}/accept`, {});
    const agent = ((await http.get('/agents')).data.agents as { slug: string; prompt: string; mine: boolean }[]).find((entry) => entry.slug === slug);
    console.log(`  ${slug} now says: ${agent?.prompt}`);
    assert.equal(agent?.prompt, compared.prompt, 'the agent does not carry the accepted prompt');

    console.log('[5/5] the procedure request is handed to the agent builder, which takes it up in a new chat');
    const handed = (await http.post(`/evals/level2/changes/${procedureRequest.id}/hand-over`, {})).data.change as Change & { runId?: string };
    conversationId = handed.conversationId;
    assert.ok(conversationId && handed.runId, 'the hand-over opened no conversation or run');
    const denied = new Set<string>();
    const builderTraces = await until('the agent builder to finish its turn', 30 * 60_000, async () => {
      const traces = ((await http.get(`/engine/runs/${handed.runId}/traces`).catch(() => ({ data: { traces: [] } }))).data.traces as (Trace & { outputs?: { toolCalls?: { id: string; name: string }[] } })[]) ?? [];
      for (const call of traces.filter((trace) => trace.kind === 'call-model').flatMap((trace) => trace.outputs?.toolCalls ?? [])) {
        if (call.name !== 'save_procedure' || denied.has(call.id)) continue;
        denied.add(call.id);
        console.log('  it asked to save the procedure; denying, so the test changes nothing of the person\'s');
        await http.post(`/engine/runs/${handed.runId}/approve`, { callId: call.id, allowed: false }).catch(() => undefined);
      }
      return traces.some((trace) => trace.kind === 'finish' && trace.finish) ? traces : undefined;
    });
    const builderCalls = builderTraces.filter((trace) => trace.kind === 'run-tool-calls').flatMap((trace) => trace.outputs?.results ?? []).map((call) => call.name);
    console.log(`  the builder called: ${builderCalls.join(', ') || 'nothing'}`);
    assert.ok(builderCalls.includes('read_procedure'), 'the agent builder did not read the procedure it was asked to change');
    const replied = await db.getConversation(OWNER, conversationId);
    const reply = replied?.messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '';
    console.log(`  conversation ${conversationId} (${replied?.agentSlug}): ${replied?.messages.length ?? 0} messages; the builder said: ${reply.slice(0, 200).replace(/\n/g, ' ')}`);
    assert.ok(reply, 'the agent builder\'s turn was not saved in the conversation');
    console.log('changes live — PASS');
  } finally {
    for (const id of changeIds) await http.post(`/evals/level2/changes/${id}/dismiss`, {}).catch(() => undefined);
    if (conversationId) await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    await http.delete(`/evals/level2/scenarios/${scenarioId}`).catch(() => undefined);
    await http.delete(`/agents/${slug}`).catch(() => undefined);
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
