import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CONCEPTS } from '../coupling/concepts.js';
import { touchesIn } from '../coupling/flows.js';
import { repoGraph } from '../coupling/repo-graph.js';
import { DECISIONS } from './decisions.js';
import { driftOf, type Finding } from './drift.js';
import { everythingSaid, transcriptsOf } from './transcripts.js';
import { traceStep, type StepTrace } from './trace.js';
import { V1_FLOWS } from './v1-flows.js';

const PLANS = ['backend.md', 'machines.md', 'alignment.md', 'now.md'];

export interface Drift {
  commit: string;
  traces: Map<string, StepTrace>;
  findings: Finding[];
}

export async function currentDrift(root: string): Promise<Drift> {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const sourceOf = (file: string): string | undefined => {
    const path = join(root, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  const graph = repoGraph(root, undefined, { withinFiles: true, handOffs: true });
  const touches = touchesIn(graph, sourceOf, CONCEPTS);
  const traces = new Map(V1_FLOWS.flatMap((flow) => flow.steps).map((step) => [step.id, traceStep(graph, step, CONCEPTS.map((concept) => concept.id), touches)]));
  const said = await everythingSaid(transcriptsOf(join(homedir(), '.claude', 'projects'), dirname(resolve(commonDir))), join(commonDir, 'koala-said', 'cache.json'));
  const plansDir = join(homedir(), '.claude', 'plans');
  const plans = [
    { file: 'CLAUDE.md', text: sourceOf('CLAUDE.md') ?? '' },
    ...PLANS.filter((name) => existsSync(join(plansDir, name))).map((name) => ({ file: `~/.claude/plans/${name}`, text: readFileSync(join(plansDir, name), 'utf8') })),
  ];
  return { commit: git('rev-parse', '--short=9', 'HEAD'), traces, findings: driftOf({ flows: V1_FLOWS, decisions: DECISIONS, traces, sourceOf, plans, said }) };
}
