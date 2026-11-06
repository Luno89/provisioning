import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROOT } from '../coupling/artifacts.js';
import { CONCEPTS } from '../coupling/concepts.js';
import { touchesIn } from '../coupling/flows.js';
import { repoGraph } from '../coupling/repo-graph.js';
import { DECISIONS } from './decisions.js';
import { driftOf } from './drift.js';
import { driftPage } from './drift-page.js';
import { everythingSaid, transcriptsOf } from './transcripts.js';
import { traceStep } from './trace.js';
import { V1_FLOWS } from './v1-flows.js';

const PLANS = ['backend.md', 'machines.md', 'alignment.md', 'now.md'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pageAt = args.indexOf('--page');
  const page = pageAt >= 0 ? args[pageAt + 1] : undefined;
  if (pageAt >= 0 && !page) throw new Error('usage: npm run drift -- [--page <file.html>]');
  const git = (...gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const sourceOf = (file: string): string | undefined => {
    const path = join(ROOT, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };

  const started = Date.now();
  const graph = repoGraph(ROOT, undefined, { withinFiles: true, handOffs: true });
  const touches = touchesIn(graph, sourceOf, CONCEPTS);
  const traces = new Map(V1_FLOWS.flatMap((flow) => flow.steps).map((step) => [step.id, traceStep(graph, step, CONCEPTS.map((concept) => concept.id), touches)]));
  const said = await everythingSaid(transcriptsOf(join(homedir(), '.claude', 'projects'), dirname(resolve(commonDir))), join(commonDir, 'koala-said', 'cache.json'));
  const plansDir = join(homedir(), '.claude', 'plans');
  const plans = [
    { file: 'CLAUDE.md', text: sourceOf('CLAUDE.md') ?? '' },
    ...PLANS.filter((name) => existsSync(join(plansDir, name))).map((name) => ({ file: `~/.claude/plans/${name}`, text: readFileSync(join(plansDir, name), 'utf8') })),
  ];
  const findings = driftOf({ flows: V1_FLOWS, decisions: DECISIONS, traces, sourceOf, plans, said });

  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  for (const finding of findings) console.log(`[${finding.kind}] ${finding.title}${finding.steps.length ? `  (${finding.steps.join(', ')})` : ''}`);
  console.log(`\n${findings.length} inconsistencies: ${[...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ')}, in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  if (page) {
    mkdirSync(dirname(resolve(page)), { recursive: true });
    writeFileSync(page, driftPage({ flows: V1_FLOWS, decisions: DECISIONS, traces, findings, commit: git('rev-parse', '--short=9', 'HEAD') }));
    console.log(`the drift page is at ${page}`);
  }
}

main().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
