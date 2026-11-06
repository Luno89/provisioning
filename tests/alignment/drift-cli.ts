import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../coupling/artifacts.js';
import { ANSWERS } from './answers.js';
import { DECISIONS } from './decisions.js';
import { driftPage } from './drift-page.js';
import { currentDrift } from './drift-run.js';
import { gateOf, gateRefusal } from './gate.js';
import { V1_FLOWS } from './v1-flows.js';

const USAGE = 'usage: npm run drift -- [--check] [--page <file.html>]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pageAt = args.indexOf('--page');
  const page = pageAt >= 0 ? args[pageAt + 1] : undefined;
  if (pageAt >= 0 && !page) throw new Error(USAGE);
  const started = Date.now();
  const drift = await currentDrift(ROOT);
  const gate = gateOf(drift.findings, ANSWERS);
  const state = (id: string): string => gate.asked.some((finding) => finding.id === id) ? ' [asked]' : gate.noted.some((finding) => finding.id === id) ? ' [noted]' : '';
  for (const finding of drift.findings) console.log(`[${finding.kind}] ${finding.title}${finding.steps.length ? `  (${finding.steps.join(', ')})` : ''}${state(finding.id)}`);
  const counts = new Map<string, number>();
  for (const finding of drift.findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  console.log(`\n${drift.findings.length} inconsistencies: ${[...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ')}; ${gate.open.length} not yet asked, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (page) {
    mkdirSync(dirname(resolve(page)), { recursive: true });
    writeFileSync(page, driftPage({ flows: V1_FLOWS, decisions: DECISIONS, traces: drift.traces, findings: drift.findings, answers: ANSWERS, commit: drift.commit }));
    console.log(`the drift page is at ${page}`);
  }
  const refusal = gateRefusal(gate);
  if (args.includes('--check') && refusal) {
    console.error(`\n${refusal}`);
    process.exitCode = 1;
  }
}

main().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
