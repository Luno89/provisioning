/**
 * Drives a real suite against the real harness, printing what the Lab would show.
 *
 * Not a test — it needs a model endpoint and a cluster, and each run is a real sandbox. It exists
 * because the matrix is the part worth checking against reality: the arithmetic is unit-tested, but
 * whether a suite of three tasks actually SEPARATES two variants is a question only real runs answer.
 */
import { createDatabase } from './lib/db-interface.js';
import { createModelService } from './lib/model-wiring.js';
import { ExperimentService } from './services/ExperimentService.js';
import {
  expandAxes, validateExperiment, summariseResults, overclaimed, plannedRuns,
  buildTaskMatrix, discriminatingTasks, experimentTasks,
  type Experiment,
} from './lib/experiments.js';

const db = createDatabase();
await db.init();
const models = createModelService(db, process.env.JWT_SECRET!);
const svc = new ExperimentService(db, models);

/**
 * `--smoke` runs one trivial task on one variant.
 *
 * Worth having as a first move rather than a fallback. The full suite costs the better part of an
 * hour, and if the harness cannot complete ANYTHING the result is a matrix of uniform failure —
 * which the matrix itself will correctly label as no signal, after an hour of GPU time. Establish
 * the floor, then spend the hour.
 */
const smoke = process.argv.includes('--smoke');

/**
 * `--minimal` — the smallest experiment that answers a real question.
 *
 * One task, two prompts, one run each: two sandboxes. The question is not "which wording is
 * nicer" but "does the agent emit a tool call at all", which the live trace answered with a flat
 * no across 24 steps on the prompt that ships. Bisecting the prompt against the endpoint showed
 * the same facts stated tersely restore it 5/5, so this is that bisect promoted into a measured
 * experiment — the first one here whose numbers can differ.
 */
const minimal = process.argv.includes('--minimal');

/**
 * The same facts as `describeSandbox`, without the prose that invites narration.
 *
 * Deliberately keeps what an agent cannot infer and would waste an attempt discovering: no network,
 * a fresh shell per command, one writable directory, no root.
 */
const TERSE_PROMPT = [
  'You complete one piece of work in a sandboxed Linux container by calling tools.',
  '',
  'Facts: node 22 is installed. /work is the only writable directory. There is NO network, so',
  'installs and clones fail. You are not root. Each command runs in a fresh shell, so chain with',
  '&& or use absolute paths.',
  '',
  'Call finish when the work is done or you are stuck.',
].join('\n');

const SMOKE_TASKS = [{
  id: 't1',
  name: 'write a file',
  // About as small as a task can be while still exercising the whole loop: the model must write a
  // file and run it, and the verify command checks the artefact rather than the agent's report.
  prompt: 'Create /work/hello.js which prints exactly PASS when run with node. Then run it.',
  verifyCommand: 'cd /work && node hello.js | grep -q PASS',
}];

/**
 * A fresh id per run, and the record is KEPT.
 *
 * This used to be a fixed id that was deleted on the way out, so each run overwrote the last and
 * then erased itself — an afternoon of experiments left no history at all, and every question of
 * the form "what did the previous one do differently" was unanswerable. A probe is still an
 * experiment; the results cost real GPU time and belong in the same list as any other.
 */
const runId = `lab-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;

const exp: Experiment = {
  id: runId, ownerId: '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991',
  name: minimal ? 'does the agent call a tool at all'
    : smoke ? 'smoke — can the harness finish anything'
    : 'reasoning on dispatch turns',
  tasks: smoke || minimal ? SMOKE_TASKS : [
    {
      id: 't1',
      name: 'fib',
      prompt: [
        'Create /work/fib.js exporting a function fib(n) returning the nth Fibonacci number.',
        'Then create /work/test.js which requires it, checks fib(10) === 55, and prints "PASS" or throws.',
        'Run it with node and make sure it passes.',
      ].join('\n'),
      verifyCommand: 'cd /work && node test.js',
    },
    {
      // Deliberately needs a file READ before anything can be written — the shape of task the
      // dispatch loop is worst at, and the one where reasoning might actually earn its budget.
      id: 't2',
      name: 'fix the failing test',
      prompt: [
        'Create /work/sum.js exporting sum(numbers) that adds an array of numbers,',
        'and /work/sum.test.js that checks sum([1,2,3]) === 6 and sum([]) === 0, printing "PASS" or throwing.',
        'The empty-array case is the one that catches a naive implementation. Run it and make it pass.',
      ].join('\n'),
      verifyCommand: 'cd /work && node sum.test.js',
    },
    {
      id: 't3',
      name: 'parse csv',
      prompt: [
        'Create /work/data.csv with a header row (name,qty) and three data rows.',
        'Create /work/parse.js exporting parse(text) returning an array of objects, and /work/parse.test.js',
        'which reads data.csv, parses it, checks there are 3 rows and that qty values are numbers, printing "PASS".',
      ].join('\n'),
      verifyCommand: 'cd /work && node parse.test.js',
    },
  ],
  language: 'node',
  // One variant in smoke mode: the question is whether the harness works at all, and a comparison
  // between two configurations that both fail answers nothing.
  variants: minimal
    // The control is the prompt that SHIPS — an experiment against the built-in constants would
    // be measuring something nobody runs.
    ? [
        { label: 'shipped-prompt', overrides: {} },
        { label: 'terse-prompt', overrides: { systemPrompt: TERSE_PROMPT } },
      ]
    : smoke ? [{ label: 'default', overrides: {} }]
    : expandAxes({ think: [false, true] }),
  repeats: 1, status: 'draft', results: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

console.log('validate:', validateExperiment(exp) ?? 'ok');
console.log('variants:', exp.variants.map((v) => v.label).join(', '));
console.log(`suite:    ${experimentTasks(exp).map((t) => t.name).join(', ')}`);
console.log(`runs:     ${plannedRuns(exp)} sandboxes\n`);

await db.saveExperiment(exp);
svc.start(exp);

/**
 * A deadline derived from the plan, not a round number of polls.
 *
 * This was a flat 400 iterations — about 33 minutes — chosen when a suite meant two short runs.
 * A six-run suite where one variant burns the full 15-minute variant timeout needs three times
 * that, and when the count ran out the script tore down Mongo underneath a variant that was still
 * executing, crashing it and orphaning its sandbox. Bounding by what the experiment can actually
 * take means the limit tracks the plan instead of a guess about it.
 */
const VARIANT_CEILING_MS = 15 * 60_000;
const deadline = Date.now() + plannedRuns(exp) * (VARIANT_CEILING_MS + 60_000);

// Poll exactly as the UI does.
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const cur = (await db.getExperiments()).find((e) => e.id === exp.id)!;
  if (cur.progress) console.log(`  [${cur.status}] ${cur.progress}`);
  /**
   * BOTH conditions, and the second is the one that matters.
   *
   * A terminal status means the RECORD stopped, not that the work did — something else can mark it
   * failed while this process is still mid-variant. Tearing down on status alone closed the Mongo
   * client out from under a running variant, which crashed on its next save and left a sandbox
   * with nothing to destroy it. `isRunning` is this process's own knowledge of its own work, which
   * is exactly the question being asked here.
   */
  if ((cur.status === 'complete' || cur.status === 'failed') && !svc.isRunning(exp.id)) {
    if (cur.status === 'failed') console.log(`\n!! ${cur.error ?? 'no reason recorded'}`);
    const tasks = experimentTasks(cur);

    console.log('\n--- suite total ---');
    for (const s of summariseResults(cur.results)) {
      console.log(`  ${s.label.padEnd(14)} verified ${s.verified}/${s.runs}  claimed ${s.claimed}/${s.runs}` +
        `  steps ${String(s.medianSteps).padEnd(3)} tokens ${String(s.medianTokens).padEnd(7)} ` +
        `${Math.round(s.medianDurationMs / 1000)}s` + (s.errored ? `  (${s.errored} did not run)` : ''));
    }

    // The half that a single aggregate cannot show: two variants can tie above and disagree here.
    console.log('\n--- by task ---');
    const matrix = buildTaskMatrix(cur.results, tasks, exp.variants);
    const width = Math.max(...tasks.map((t) => t.name.length), 12);
    console.log(`  ${'task'.padEnd(width)}  ${exp.variants.map((v) => v.label.padEnd(12)).join('')}`);
    for (const row of matrix) {
      const name = tasks.find((t) => t.id === row.taskId)?.name ?? row.taskId;
      const cells = row.cells.map((c) => `${c.verified}/${c.runs}`.padEnd(12)).join('');
      const note = row.allFailed ? '  ← every variant failed; check the task'
        : row.uninformative ? '  ← no signal, all tied'
        : '';
      console.log(`  ${name.padEnd(width)}  ${cells}${note}`);
    }

    const separated = discriminatingTasks(matrix);
    console.log(`\ntasks that separated the variants: ${
      separated.length ? separated.map((t) => `${t.taskId} (${t.spread.toFixed(2)})`).join(', ') : 'none'}`);

    const lying = overclaimed(cur.results);
    console.log('overclaimed:', lying.length ? lying.map((r) => `${r.taskId}/${r.label}`).join(', ') : 'none');
    for (const r of cur.results) if (r.error) console.log(`  error [${r.taskId}/${r.label}]: ${r.error.slice(0, 160)}`);

    /**
     * The trace of anything that failed.
     *
     * A score says a variant did not work; only this says WHY, and the difference decides whether
     * the next move is rewording a task or fixing the loop. Printed for failures rather than for
     * everything, because a passing run's trace is thousands of lines nobody reads.
     */
    for (const r of cur.results.filter((x) => !x.verified && !x.error)) {
      console.log(`\n--- trace: ${r.taskId} / ${r.label} (${r.steps} steps) ---`);
      console.log(`summary:    ${r.summary.slice(0, 300)}`);
      console.log(`verify:     exit ${r.verifyExitCode} ${r.verifyOutput.slice(-200)}`);
      console.log(`commands:   ${r.transcript.length ? r.transcript.join(' | ').slice(0, 400) : 'NONE — it never ran anything'}`);
      for (const s of r.trace ?? []) {
        const calls = s.toolCalls.length
          ? s.toolCalls.map((c) => `${c.name}(${c.arguments.slice(0, 70)})`).join(' ')
          : '*** no tool call ***';
        console.log(`  ${String(s.step).padStart(2)} ${String(s.tokens).padStart(5)}t ${
          s.reasoning ? `[thought ${s.reasoning.length}c] ` : ''}${calls}`);
        // The first thing to check when a loop stalls: what the model said when it said nothing.
        if (!s.toolCalls.length && (s.content || s.reasoning)) {
          console.log(`     said: ${(s.content || s.reasoning || '').slice(0, 300).replace(/\n/g, ' ')}`);
        }
      }
    }
    break;
  }
}

/**
 * Teardown waits for the WORK, not for the loop above.
 *
 * Both crashes this script has produced came from the same mistake in different disguises: closing
 * Mongo while `ExperimentService.run()` was still mid-variant, once because the record went
 * terminal underneath it and once because the poll loop simply ran out. Guarding only the break
 * path left the fall-through unguarded, so the guard belongs here, where every path meets.
 */
for (let i = 0; svc.isRunning(exp.id) && i < 200; i++) {
  if (i === 0) console.log('\nWaiting for the variant still in flight before tearing down…');
  await new Promise((r) => setTimeout(r, 5000));
}
if (svc.isRunning(exp.id)) {
  // Said out loud rather than exiting quietly: whatever is still running owns a sandbox, and
  // nothing left behind will destroy it.
  console.warn('\n!! Still running after the wait — the experiment stays in place.');
  console.warn('!! Check for leftover sandboxes: kubectl get ns | grep koala-ws');
}
// Kept either way. The record IS the history, and deleting it was why there was none.
console.log(`\nkept as experiment ${exp.id} — visible in the Lab, with the prompt each run was sent.`);
await db.close();

/**
 * Exits rather than returning.
 *
 * `ModelService.resolveBaseUrl` stands up a `kubectl port-forward` child to reach the model, and
 * nothing here owns it — so closing Mongo is not enough to drain the event loop and the script
 * hangs indefinitely with the forward still held. Observed: two probes still alive half an hour
 * after printing their results, each holding a port-forward. A server would tear these down on
 * shutdown; a one-shot script has no shutdown, so it says so and leaves.
 */
process.exit(0);
