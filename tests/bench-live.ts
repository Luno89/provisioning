import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { io as connect } from 'socket.io-client';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { fingerprintOf } from '../apps/backend/src/lib/bench.js';
import { liveEngineHost } from './lib/live-engine-host.js';

const BASE = process.env.BENCH_LIVE_URL ?? 'http://localhost:3001/api';
const ORIGIN = BASE.replace(/\/api$/, '');
const OWNER = process.env.BENCH_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
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

interface Run { id: string; state: string; startedAt: string; trigger?: { kind: string; agents?: string[] }; results: { scenarioId: string; passed: boolean; checks: { what: string; passed: boolean; detail: string }[] }[]; regressions?: string[] }

async function main(): Promise<void> {
  assert.ok(OWNER, 'set BENCH_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the bench uses');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const cookie = `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}`;
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: cookie } });
  const socket = connect(ORIGIN, { extraHeaders: { Cookie: cookie }, transports: ['websocket'] });
  const regressionsSeen: { runId: string; regressions: string[] }[] = [];
  socket.on('bench-regression', (event: { runId: string; regressions: string[] }) => { regressionsSeen.push(event); });

  const slug = `bench-live-${Date.now().toString(36)}`;
  const scenarioId = `${slug}-checks-tasks`;
  const before = (await http.get('/evals/level2/bench')).data as { settings: unknown; state: { benched: Record<string, string>; lastFullAt?: string } };
  const agent = (prompt: string, tools: string[]) => ({
    slug, name: 'Bench live check', description: 'Looks at the task list before it answers', version: '1', prompt,
    guidance: 'Only for the bench live test.', returns: 'An answer.', failures: [{ when: 'never', says: 'so' }],
    procedure: 'tool-rounds', tools, environment: {},
  });
  const runsOf = async () => ((await http.get('/evals/level2/runs')).data.runs as Run[]).filter((run) => run.trigger?.kind === 'changed' && run.trigger.agents?.includes(slug));
  const benchRun = async (what: string, after: number) => {
    const started = await until(`the bench to start on its own (${what})`, 10 * 60_000, async () => (await runsOf()).find((run) => Date.parse(run.startedAt) > after));
    console.log(`  bench run ${started.id} started on its own (${started.trigger?.kind}: ${started.trigger?.agents?.join(', ')})`);
    return until(`bench run ${started.id} to finish`, 30 * 60_000, async () => {
      const run = (await http.get(`/evals/level2/runs/${started.id}`)).data as Run;
      return run.state === 'running' ? undefined : run;
    });
  };

  try {
    console.log('[1/4] the bench idles after one minute; every other agent counts as already benched');
    await http.put('/evals/level2/bench', { enabled: true, idleMinutes: 1, fullEveryHours: 24 * 365 });
    const host = liveEngineHost(db);
    const others = (await http.get('/evals/level2/scenarios')).data.scenarios as { agent: string }[];
    const benched: Record<string, string> = {};
    for (const name of new Set(others.map((scenario) => scenario.agent))) {
      const runnable = await host.registry.runnable(OWNER, name).catch(() => undefined);
      if (runnable) benched[name] = fingerprintOf({ agent: runnable.agent, procedure: runnable.procedure });
    }
    await db.saveBenchState({ ownerId: OWNER, benched, lastFullAt: new Date().toISOString() });

    console.log('[2/4] a new agent and its scenario; saving it starts the countdown, and the bench runs it');
    const savedAt = Date.now();
    assert.ok((await http.put(`/agents/${slug}`, agent('Before you answer anything, always call list_tasks once to see what is open, then answer in one short sentence.', ['list_tasks']))).status < 300);
    const scenario = {
      id: scenarioId, name: 'Looks at the tasks first', describe: 'It calls list_tasks before answering.', agent: slug,
      procedure: { id: 'tool-rounds' }, input: { message: 'What should I work on next?' }, expect: { outcome: 'ok', toolsCalled: ['list_tasks'] },
    };
    assert.ok((await http.put(`/evals/level2/scenarios/${scenarioId}`, scenario)).status < 300);
    const first = await benchRun('first', savedAt);
    const firstResult = first.results.find((result) => result.scenarioId === scenarioId);
    console.log(`  ${scenarioId}: ${firstResult?.passed ? 'passed' : `failed — ${firstResult?.checks.filter((check) => !check.passed).map((check) => check.detail).join('; ')}`}`);
    assert.ok(firstResult?.passed, 'the scenario did not pass on the working agent, so a regression cannot be shown');

    console.log('[3/4] the agent loses list_tasks; the bench notices it changed and runs it again');
    const brokenAt = Date.now();
    assert.ok((await http.put(`/agents/${slug}`, agent('Before you answer anything, always call list_tasks once to see what is open, then answer in one short sentence.', []))).status < 300);
    const second = await benchRun('after the change', brokenAt);
    console.log(`  regressions: ${(second.regressions ?? []).join(', ') || 'none'}`);
    assert.deepEqual(second.regressions, [scenarioId], 'the bench did not name the broken scenario as a regression');

    console.log('[4/4] the owner is told');
    await until('the regression notice', 60_000, async () => (regressionsSeen.some((event) => event.runId === second.id) ? true : undefined));
    console.log(`  notice: ${JSON.stringify(regressionsSeen.find((event) => event.runId === second.id))}`);
    console.log('bench live — PASS');
  } finally {
    socket.close();
    await http.delete(`/evals/level2/scenarios/${scenarioId}`).catch(() => undefined);
    await http.delete(`/agents/${slug}`).catch(() => undefined);
    await http.put('/evals/level2/bench', before.settings).catch(() => undefined);
    await db.saveBenchState({ ownerId: OWNER, benched: before.state.benched, ...(before.state.lastFullAt ? { lastFullAt: before.state.lastFullAt } : {}) });
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
