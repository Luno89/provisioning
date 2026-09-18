import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const APP = process.env.EVAL_APP ?? 'http://localhost:5173';
const API = process.env.EVAL_API ?? 'http://localhost:3001';
const PROFILE = process.env.EVAL_PROFILE ?? '.eval-browser-profile';
const MODEL_ID = process.env.MODEL_ID ?? 'Tabbyapi-Production';
const REPEATS = Number(process.env.REPEATS ?? 10);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : undefined;
const TEMPERATURE = process.env.TEMPERATURE ? Number(process.env.TEMPERATURE) : undefined;
const MAX_TOKENS = process.env.MAXTOK ? Number(process.env.MAXTOK) : undefined;

mkdirSync(PROFILE, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.HEADED !== '1',
    viewport: { width: 1280, height: 900 },
  });

  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(`${APP}/#/evals`);

  process.stdout.write('waiting for a signed-in session');
  let authed = false;
  for (let i = 0; i < 300; i += 1) {
    const probe = await ctx.request.get(`${API}/api/evals/cases`).catch(() => undefined);
    if (probe && probe.ok() && (probe.headers()['content-type'] ?? '').includes('json')) {
      authed = true;
      break;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  if (!authed) throw new Error('never saw a signed-in session — log in at ' + APP);
  console.log('\nsigned in');

  const cases = await (await ctx.request.get(`${API}/api/evals/cases`)).json();
  const uncovered = (cases.coverage ?? []).filter((g: { kind: string }) => g.kind === 'uncovered');
  console.log(`${cases.cases.length} cases · ${uncovered.length} uncovered tool(s): ${uncovered.map((g: { case: string }) => g.case).join(', ') || 'none'}`);

  const models = await (await ctx.request.get(`${API}/api/models`)).json();
  const choices = Array.isArray(models) ? models : (models.models ?? []);
  const chosen = choices.find((m: { id: string }) => m.id === MODEL_ID);
  if (!chosen) {
    throw new Error(
      `no endpoint with id "${MODEL_ID}". Available: ${choices.map((m: { id: string; name: string }) => `${m.id} (${m.name})`).join(', ')}`,
    );
  }
  console.log(`model: ${chosen.name} [${chosen.id}]`);

  const started = await (await ctx.request.post(`${API}/api/evals/runs`, {
    data: {
      repeats: REPEATS,
      ...(ONLY ? { only: ONLY } : {}),
      ...(TEMPERATURE === undefined ? {} : { temperature: TEMPERATURE }),
      ...(MAX_TOKENS === undefined ? {} : { maxTokens: MAX_TOKENS }),
      modelId: MODEL_ID,
      modelLabel: MODEL_ID,
    },
  })).json();

  if (!started.id) throw new Error(`run did not start: ${JSON.stringify(started)}`);
  console.log(`run ${started.id} — ${started.total} cases x ${started.repeats}`);

  let last = -1;
  for (;;) {
    const run = await (await ctx.request.get(`${API}/api/evals/runs/${started.id}`)).json();
    if (run.finished !== last) {
      last = run.finished;
      console.log(`  ${run.finished}/${run.total}${run.running ? ` — ${run.running}` : ''}`);
    }
    if (run.state !== 'running') {
      console.log(`\nstate: ${run.state}${run.error ? ` — ${run.error}` : ''}`);
      console.log('reliability:', JSON.stringify(run.reliability));
      console.log('\n--- by tool ---');
      for (const t of run.tools ?? []) {
        console.log(`  ${String(t.passed).padStart(3)}/${String(t.attempts).padEnd(3)} ${t.tool}  (${t.cases} case${t.cases === 1 ? '' : 's'})`);
        for (const c of t.complaints) console.log(`           ${c}`);
      }
      console.log('\n--- by case ---');
      for (const o of run.outcomes ?? []) {
        const mark = o.passed === o.attempts ? 'pass ' : o.passed === 0 ? 'FAIL ' : 'flaky';
        console.log(`  ${mark} ${o.name.padEnd(42)} ${o.passed}/${o.attempts}`);
      }
      break;
    }
    await sleep(5000);
  }

  await ctx.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
