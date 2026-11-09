import type { Decision } from './decisions.js';
import type { Flow, Step } from './flow-spec.js';
import type { Said } from './said.js';
import type { StepTrace } from './trace.js';

export type FindingKind = 'missing' | 'two-paths' | 'decided-not-done' | 'undecided-branch' | 'misquote' | 'assumption';

export interface Finding {
  id: string;
  kind: FindingKind;
  steps: string[];
  title: string;
  detail: string;
  where: string[];
}

export interface ModelWord {
  word: string;
  pattern: RegExp;
  decidedBy: string[];
  goes?: string;
}

export const MODEL_WORDS: ModelWord[] = [
  { word: 'k3d', pattern: /\bk3d\b/i, decidedBy: ['how-a-machine-cluster-is-made', 'no-koala-made-k3d-clusters'], goes: 'Koala making k3d clusters beside itself goes; k3d stays only as how a machine without a GPU wanted and with Docker makes its cluster, which the machine agent does.' },
  { word: 'Docker', pattern: /(?<!\.)\bdocker\b/i, decidedBy: ['how-a-machine-cluster-is-made', 'koala-work-in-pods'], goes: 'Koala never installs Docker, and its work on a machine runs only in pods: no Docker driver, no Docker socket.' },
  { word: 'sudo', pattern: /\bsudo\b/, decidedBy: ['how-a-machine-cluster-is-made', 'side-with-the-user', 'agents-on-the-host', 'cluster-on-demand'] },
  { word: 'a cloud provider', pattern: /\bprovider\s*(===|!==)|\b(hetzner|digitalocean)\b/i, decidedBy: ['providers', 'one-cluster-per-machine'], goes: 'Hetzner, DigitalOcean and mock cloud go, and a cluster has one kind, a machine\'s, so nothing branches on a provider.' },
  { word: 'the system cluster', pattern: /\bisSystem\b|\bgpuEnabled\b|provisioning-lunorica|SYSTEM_CLUSTER/, decidedBy: ['one-cluster-per-machine'], goes: 'There is one kind of cluster, a machine\'s; the system cluster as a kind of its own goes, including gpuEnabled, which doubles as "this is the management cluster".' },
  { word: 'the combined role', pattern: /['"]combined['"]/, decidedBy: ['dev-runs-like-prod'], goes: 'Dev runs production\'s shape, root and an instance apart, so the combined role goes.' },
  { word: 'mock mode', pattern: /\bisMock\w*|\bmock(Cloud|Mode)\b/, decidedBy: ['providers'], goes: 'Mock cloud mode goes.' },
  { word: 'a GPU', pattern: /\bgpus?(\.length)?\s*(===|!==|>|<)/i, decidedBy: ['gpu-is-core', 'gpu-unusable'] },
];

const BRANCHING = /\bif\s*\(|\belse if\b|===|!==|\?\s|\bcase\s|\bswitch\s*\(/;

export interface DriftInput {
  flows: readonly Flow[];
  decisions: readonly Decision[];
  traces: ReadonlyMap<string, StepTrace>;
  sourceOf: (file: string) => string | undefined;
  plans: ReadonlyArray<{ file: string; text: string }>;
  said: readonly Said[];
}

const meetingPlace = (file: string): boolean => !file.startsWith('apps/frontend/') && !file.includes('/wiring/') && !file.includes('/routes/');

const stepsIn = (flows: readonly Flow[]): Step[] => flows.flatMap((flow) => flow.steps);

const settledBy = (step: Step): Set<string> => new Set([...step.decisions, ...(step.branches ?? []).map((branch) => branch.decision)]);

const PROSE = /`[^`]*`|'[^']*\s[^']*'|"[^"]*\s[^"]*"/g;

export const codeOf = (line: string): string => line.replace(PROSE, '""');

function missing(steps: readonly Step[], traces: ReadonlyMap<string, StepTrace>): Finding[] {
  return steps.flatMap((step): Finding[] => {
    const trace = traces.get(step.id);
    if (!trace || trace.starts.length === 0) {
      return [{ id: `missing:${step.id}`, kind: 'missing', steps: [step.id], title: `${step.id} names no code`, detail: 'Nothing in the repository is named as doing this step, so either nothing does it yet or the flow has not been told what does.', where: [] }];
    }
    if (trace.notFound.length > 0) {
      return [{ id: `missing:${step.id}`, kind: 'missing', steps: [step.id], title: `${step.id} cannot be followed`, detail: 'The map does not hold where this step starts (a script appears in it only by the Koala API calls it makes).', where: trace.notFound }];
    }
    return [];
  });
}

function twoPaths(steps: readonly Step[], traces: ReadonlyMap<string, StepTrace>): Finding[] {
  const byJob = new Map<string, Step[]>();
  for (const step of steps) if (step.job) byJob.set(step.job, [...(byJob.get(step.job) ?? []), step]);
  return [...byJob.entries()].flatMap(([job, doing]): Finding[] => {
    const starts = new Map(doing.map((step) => [step.id, [...(traces.get(step.id)?.starts ?? [])].sort().join(' + ')]));
    if (new Set(starts.values()).size <= 1) return [];
    const shared = doing.map((step) => new Set((traces.get(step.id)?.files ?? []).filter(meetingPlace)))
      .reduce((common, files) => new Set([...common].filter((file) => files.has(file))));
    if (shared.size > 0) return [];
    return [{
      id: `two-paths:${job}`,
      kind: 'two-paths',
      steps: doing.map((step) => step.id),
      title: `${job}: ${new Set(starts.values()).size} ways in the code`,
      detail: 'Steps doing the same job start from different code and never meet in the same service or store. Either they are two paths for one job, or they are different jobs and the flows should say so.',
      where: [...starts.entries()].map(([step, code]) => `${step}: ${code}`),
    }];
  });
}

function undecidedBranches(steps: readonly Step[], traces: ReadonlyMap<string, StepTrace>, sourceOf: (file: string) => string | undefined): Finding[] {
  const findings = new Map<string, { word: ModelWord; steps: Set<string>; lines: Set<string> }>();
  const linesOf = new Map<string, string[]>();
  for (const step of steps) {
    const covered = settledBy(step);
    for (const file of traces.get(step.id)?.files ?? []) {
      if (!linesOf.has(file)) linesOf.set(file, (sourceOf(file) ?? '').split('\n'));
      linesOf.get(file)!.forEach((line, index) => {
        const code = codeOf(line);
        if (!BRANCHING.test(code) || /^\s*(\/\/|\*|#)/.test(code)) return;
        for (const word of MODEL_WORDS) {
          if (!word.pattern.test(code)) continue;
          if (!word.goes && word.decidedBy.some((decision) => covered.has(decision))) continue;
          const entry = findings.get(word.word) ?? { word, steps: new Set<string>(), lines: new Set<string>() };
          entry.steps.add(step.id);
          entry.lines.add(`${file}:${index + 1}  ${line.trim().slice(0, 140)}`);
          findings.set(word.word, entry);
        }
      });
    }
  }
  return [...findings.values()].map(({ word, steps: on, lines }): Finding => word.goes ? {
    id: `decided-not-done:${word.word}`,
    kind: 'decided-not-done',
    steps: [...on].sort(),
    title: `The code still branches on ${word.word} in ${lines.size} place${lines.size === 1 ? '' : 's'}, which the decisions remove`,
    detail: `${word.goes} (${word.decidedBy.join(', ')}). This is work the decisions already call for, not a question.`,
    where: [...lines].sort(),
  } : {
    id: `undecided-branch:${word.word}`,
    kind: 'undecided-branch',
    steps: [...on].sort(),
    title: `The code branches on ${word.word} in ${lines.size} place${lines.size === 1 ? '' : 's'}, and no branch of these steps says which decision settles it`,
    detail: `Decisions that might: ${word.decidedBy.join(', ')}. Either the branch is one a decision covers and the step should say so, or it needs a decision.`,
    where: [...lines].sort(),
  });
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
const OWNER_QUOTES = /\bowner\b[^"\n]{0,60}?(("[^"\n]{12,}")(?:[^"\n]{0,40}?("[^"\n]{12,}"))*)/gi;

function misquotes(plans: DriftInput['plans'], said: readonly Said[]): Finding[] {
  const spoken = said.map((entry) => flat(entry.text));
  const findings: Finding[] = [];
  for (const plan of plans) {
    const lines = plan.text.split('\n');
    lines.forEach((line, index) => {
      for (const found of line.matchAll(OWNER_QUOTES)) {
        for (const quoted of found[1]!.match(/"[^"\n]{12,}"/g) ?? []) {
          const parts = quoted.slice(1, -1).split(/\.\.\.|…/).map(flat).filter((part) => part.length > 3);
          if (parts.every((part) => spoken.some((text) => text.includes(part)))) continue;
          findings.push({
            id: `misquote:${plan.file}:${index + 1}`,
            kind: 'misquote',
            steps: [],
            title: `${plan.file}:${index + 1} quotes the owner with words they did not say`,
            detail: `${quoted} is in no message of the owner's. Either it was reworded, or it came from somewhere other than this project's sessions.`,
            where: [`${plan.file}:${index + 1}`],
          });
        }
      }
    });
  }
  return findings;
}

function assumptions(steps: readonly Step[]): Finding[] {
  return steps.filter((step) => step.assumed).map((step) => ({
    id: `assumption:${step.id}`,
    kind: 'assumption' as const,
    steps: [step.id],
    title: `${step.id} rests on an assumption of mine`,
    detail: step.assumed!,
    where: [],
  }));
}

export function driftOf(input: DriftInput): Finding[] {
  const steps = stepsIn(input.flows);
  return [
    ...missing(steps, input.traces),
    ...twoPaths(steps, input.traces),
    ...undecidedBranches(steps, input.traces, input.sourceOf),
    ...misquotes(input.plans, input.said),
    ...assumptions(steps),
  ];
}
