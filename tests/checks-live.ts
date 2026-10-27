import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';

const BASE = process.env.CHECKS_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.CHECKS_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const ONLY = (process.env.CHECKS_LIVE_SCENARIOS ?? 'executor-reads-what-is-there,executor-does-one-task,builder-reads-before-changing,research-writes-its-findings,koala-fans-research-out,judge-checks-then-records-its-verdict,delivery-plans-and-delivers').split(',');
const EVERY_ONE = process.env.CHECKS_LIVE_ALL_PASS === 'true';
const TOGETHER = Math.max(1, Math.min(ONLY.length, Number(process.env.CHECKS_LIVE_TOGETHER ?? 1) || 1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result { scenarioId: string; runId: string; passed: boolean; outcome: string; reason?: string; error?: string; checks: { what: string; passed: boolean; detail: string }[]; attempts?: { runId: string; passed: boolean }[] }

async function main(): Promise<void> {
  assert.ok(OWNER, 'set CHECKS_LIVE_OWNER (or GROVE_LIVE_OWNER) to the person whose model and agents the checks use');
  const db = createDatabase();
  await db.init();
  const user = await db.accounts.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` }, validateStatus: () => true });
  const spacesBefore = (await db.accounts.getUsers()).filter((entry) => entry.space).length;

  try {
    const shares = Array.from({ length: TOGETHER }, (_, share) => ONLY.filter((_, index) => index % TOGETHER === share));
    console.log(`[1] a Level 2 run of ${ONLY.length} scenarios starts on the check runner${TOGETHER > 1 ? `, as ${TOGETHER} runs side by side` : ''}`);
    const ids: string[] = [];
    for (const share of shares) {
      const started = await http.post('/evals/level2/runs', { only: share });
      assert.equal(started.status, 202, JSON.stringify(started.data));
      ids.push((started.data as { id: string }).id);
      console.log(`    run ${ids.at(-1)} (${share.length} scenarios)`);
    }

    console.log('[2] it runs each scenario in a space of its own, through the API, to the end');
    type Run = { state: string; running?: string; finished: number; results: Result[]; error?: string };
    const runs = new Map<string, Run>();
    let last = '';
    for (;;) {
      await sleep(10_000);
      for (const id of ids) runs.set(id, (await http.get(`/evals/level2/runs/${id}`)).data as Run);
      const all = [...runs.values()];
      const now = `${all.every((entry) => entry.state !== 'running') ? 'done' : 'running'} ${all.reduce((total, entry) => total + entry.finished, 0)}/${ONLY.length}${all.some((entry) => entry.running) ? ` — ${all.flatMap((entry) => (entry.running ? [entry.running] : [])).join(', ')}` : ''}`;
      if (now !== last) { console.log(`    ${new Date().toISOString().slice(11, 19)} ${now}`); last = now; }
      if (all.every((entry) => entry.state !== 'running')) break;
    }
    for (const [id, entry] of runs) assert.equal(entry.state, 'done', `the run ${id} ended ${entry.state}: ${entry.error ?? ''}`);
    const run = { results: [...runs.values()].flatMap((entry) => entry.results) };
    for (const result of run.results) {
      console.log(`\n    ${result.passed ? 'PASS' : 'FAIL'} ${result.scenarioId} (${result.outcome}${result.reason ? `: ${result.reason.slice(0, 160)}` : ''}) run ${result.runId}`);
      for (const check of result.checks) console.log(`      ${check.passed ? '✓' : '✗'} ${check.what} — ${check.detail.slice(0, 200)}`);
      if (result.attempts) console.log(`      attempts: ${result.attempts.map((attempt) => `${attempt.passed ? '✓' : '✗'} ${attempt.runId}`).join(', ')}`);
      if (result.error) console.log(`      error: ${result.error}`);
    }
    assert.deepEqual(run.results.map((result) => result.scenarioId).sort(), [...ONLY].sort(), 'not every scenario has a result');
    assert.deepEqual(run.results.filter((result) => !result.runId).map((result) => `${result.scenarioId}: ${result.error}`), [], 'a scenario never got a real run');
    if (EVERY_ONE) assert.deepEqual(run.results.filter((result) => !result.passed).map((result) => result.scenarioId), [], 'every check has to pass here (CHECKS_LIVE_ALL_PASS)');

    console.log('\n[3] the person can still open every run, and no space is left behind');
    for (const result of run.results) {
      for (const runId of result.attempts ? result.attempts.map((attempt) => attempt.runId) : [result.runId]) {
        const traces = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as unknown[];
        assert.ok(traces.length > 0, `${result.scenarioId}'s run ${runId} does not open for the person`);
      }
    }
    const spacesAfter = (await db.accounts.getUsers()).filter((entry) => entry.space);
    console.log(`    every run opens; spaces before ${spacesBefore}, after ${spacesAfter.length}`);
    assert.equal(spacesAfter.length, spacesBefore, `spaces were left behind: ${spacesAfter.map((entry) => entry.id).join(', ')}`);
    console.log(`checks live — PASS (${run.results.filter((result) => result.passed).length} of ${run.results.length} scenarios passed on the model)`);
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
