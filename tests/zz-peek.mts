import dotenv from 'dotenv';
dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });
const { createDatabase } = await import('../apps/backend/src/lib/db-interface.js');
const db = createDatabase(); await db.init();
const run = await db.getEvalRecord<any>('evalScenarioRuns', 'bbd5483a-16ca-4dfb-a865-757c064b5b75', process.argv[2]!);
for (const r of run.results) { console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.scenarioId} (${r.outcome}${r.reason ? ': ' + r.reason.slice(0, 300) : ''}) ${r.runId} ${r.durationMs}ms`); for (const c of r.checks) console.log(`   ${c.passed ? '✓' : '✗'} ${c.what} — ${c.detail.slice(0, 300)}`); if (r.error) console.log('   error', r.error); }
await db.close(); process.exit(0);
