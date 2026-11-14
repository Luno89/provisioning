import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import axios from 'axios';
import { devKoalaApi, devKoalaDatabase, devOwner } from './lib/dev-stack.js';
import { madeHere } from './lib/made-here.js';
import { whereItFailed } from './lib/where-it-failed.js';
import { keepTimings, type Timed } from './lib/timings.js';

const BASE = process.env.CHECKS_LIVE_URL ?? `${devKoalaApi}/api`;
const ONLY = (process.env.CHECKS_LIVE_SCENARIOS ?? 'executor-reads-what-is-there,executor-does-one-task,builder-reads-before-changing,research-writes-its-findings,koala-fans-research-out,judge-checks-then-records-its-verdict,delivery-plans-and-delivers').split(',');
const TOGETHER = Math.max(1, Math.min(ONLY.length, Number(process.env.CHECKS_LIVE_TOGETHER ?? 1) || 1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result { scenarioId: string; runId: string; trace?: { traceId: string; spanId: string }; passed: boolean; outcome: string; reason?: string; error?: string; checks: { what: string; passed: boolean; detail: string }[]; attempts?: { runId: string; passed: boolean }[] }

async function main(): Promise<void> {
  const owner = await devOwner();
  const db = devKoalaDatabase();
  await db.init();
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: owner.cookie }, validateStatus: () => true });
  const spacesBefore = (await db.accounts.getUsers()).filter((entry) => entry.space).length;
  const listed = (name: string, path: string) => madeHere<{ id: string }>({ name, list: async () => (await http.get(path)).data as { id: string }[], idOf: (entry) => entry.id, stampOf: () => undefined });
  const owners = [
    madeHere<{ id: string; space?: unknown }>({ name: 'accounts', list: async () => (await db.accounts.getUsers()).filter((entry) => !entry.space), idOf: (entry) => entry.id, stampOf: () => undefined }),
    listed('conversations', '/conversations'),
    listed('projects', '/projects'),
    listed('deployments', '/deployments'),
  ];
  for (const kind of owners) await kind.before();

  try {
    console.log(`[1] ${ONLY.length} scenarios run on the check runner, each a run of its own${TOGETHER > 1 ? `, ${TOGETHER} at a time, the next starting as one ends` : ''}`);
    type Run = { state: string; running?: string; finished: number; results: Result[]; error?: string };
    const waiting = [...ONLY];
    const live = new Map<string, { scenario: string; at: number }>();
    const runs = new Map<string, Run>();
    const timed: Timed[] = [];
    const startNext = async () => {
      const scenario = waiting.shift()!;
      const started = await http.post('/evals/level2/runs', { only: [scenario] });
      assert.equal(started.status, 202, JSON.stringify(started.data));
      const { id } = started.data as { id: string };
      live.set(id, { scenario, at: Date.now() });
      console.log(`    ${new Date().toISOString().slice(11, 19)} ${scenario} starts (run ${id})`);
    };

    console.log('[2] it runs each scenario in a space of its own, through the API, to the end');
    for (;;) {
      while (live.size < TOGETHER && waiting.length > 0) await startNext();
      if (live.size === 0) break;
      await sleep(2_000);
      for (const [id, { scenario, at }] of [...live]) {
        const entry = (await http.get(`/evals/level2/runs/${id}`)).data as Run;
        if (entry.state === 'running') continue;
        runs.set(id, entry);
        live.delete(id);
        const seconds = (Date.now() - at) / 1000;
        timed.push({ at: new Date().toISOString(), commit: process.env.KOALA_GATE_COMMIT ?? '', kind: 'check', name: scenario, seconds });
        console.log(`    ${new Date().toISOString().slice(11, 19)} ${scenario} ends ${entry.state} in ${Math.round(seconds)} s; ${runs.size}/${ONLY.length} done`);
      }
    }
    for (const [id, entry] of runs) assert.equal(entry.state, 'done', `the run ${id} ended ${entry.state}: ${entry.error ?? ''}`);
    const timingsFile = process.env.KOALA_GATE_TIMINGS;
    if (timingsFile && process.env.KOALA_GATE_COMMIT) {
      const passedIds = new Set(runs.size ? [...runs.values()].flatMap((entry) => entry.results).filter((result) => result.passed).map((result) => result.scenarioId) : []);
      keepTimings(timingsFile, timed.filter((row) => passedIds.has(row.name)));
    }
    const run = { results: [...runs.values()].flatMap((entry) => entry.results) };
    for (const result of run.results) {
      console.log(`\n    ${result.passed ? 'PASS' : 'FAIL'} ${result.scenarioId} (${result.outcome}${result.reason ? `: ${result.reason.slice(0, 160)}` : ''}) run ${result.runId}`);
      for (const check of result.checks) console.log(`      ${check.passed ? '✓' : '✗'} ${check.what} — ${check.detail.slice(0, 200)}`);
      if (result.attempts) console.log(`      attempts: ${result.attempts.map((attempt) => `${attempt.passed ? '✓' : '✗'} ${attempt.runId}`).join(', ')}`);
      if (result.error) console.log(`      error: ${result.error}`);
    }
    for (const line of await whereItFailed(run.results.filter((result) => !result.passed))) console.log(line);
    const keptIn = process.env.KOALA_GATE_CHECKS;
    if (keptIn) {
      const opened = [];
      for (const result of run.results.filter((entry) => entry.passed && entry.runId)) {
        const runIds = result.attempts ? result.attempts.map((attempt) => attempt.runId) : [result.runId];
        let opens = true;
        for (const runId of runIds) opens = opens && (((await http.get(`/engine/runs/${runId}/traces`)).data as { traces?: unknown[] }).traces?.length ?? 0) > 0;
        if (opens) opened.push(result.scenarioId);
      }
      writeFileSync(keptIn, `${JSON.stringify(opened)}\n`);
    }
    assert.deepEqual(run.results.map((result) => result.scenarioId).sort(), [...ONLY].sort(), 'not every scenario has a result');
    assert.deepEqual(run.results.filter((result) => !result.runId).map((result) => `${result.scenarioId}: ${result.error}`), [], 'a scenario never got a real run');
    assert.deepEqual(run.results.filter((result) => !result.passed).map((result) => result.scenarioId), [], 'every check has to pass');

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
    for (const kind of owners) await kind.untouched();
    console.log('    every account, conversation, project and app of the owner\'s from before is still there');
    console.log(`checks live — PASS (${run.results.filter((result) => result.passed).length} of ${run.results.length} scenarios passed on the model)`);
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
