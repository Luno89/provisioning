import type { Leaf } from './leaves.js';

const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

export function isFrontier(leaf: Pick<Leaf, 'id' | 'status'>, all: Leaf[]): boolean {
  if (!FINISHED.has(leaf.status)) return false;
  return !all.some((other) => other.id !== leaf.id && (other.dependsOn ?? []).includes(leaf.id));
}

export function shouldReplan(
  leaf: Pick<Leaf, 'id' | 'status' | 'branchId'>,
  all: Leaf[],
  budget: { maxReplans?: number | undefined } | undefined,
  used: number,
): { replan: boolean; reason?: string } {
  if (!isFrontier(leaf as Leaf, all)) return { replan: false, reason: 'other work is waiting on this leaf' };
  if (budget?.maxReplans !== undefined && used >= budget.maxReplans) {
    return { replan: false, reason: `replan budget spent (${used}/${budget.maxReplans})` };
  }
  const siblings = all.filter((l) => l.branchId === leaf.branchId);
  if (siblings.some((l) => !FINISHED.has(l.status) && !(l.dependsOn ?? []).includes(leaf.id))) {
    return { replan: false, reason: 'unrelated work on this branch is still running' };
  }
  return { replan: true };
}

export interface LeafOutcome {
  title: string;
  status: string;
  verified: boolean;
  persona: string | null;
  findings?: string;
  summary?: string;
  branch?: string;
}

export const MAX_OUTCOME_CHARS = 1500;

export function summariseOutcomes(
  leaves: Leaf[],
  branchId: string,
  personaName: (id: string) => string | undefined,
): LeafOutcome[] {
  return leaves
    .filter((l) => l.branchId === branchId && FINISHED.has(l.status))
    .map((l) => ({
      title: l.title,
      status: l.status,
      verified: Boolean(l.verified),
      persona: (l.personaId && personaName(l.personaId)) || null,
      ...(l.findings?.trim() ? { findings: l.findings.slice(0, MAX_OUTCOME_CHARS) } : {}),
      ...(l.summary?.trim() ? { summary: l.summary.slice(0, MAX_OUTCOME_CHARS) } : {}),
      ...(l.outputBranch ? { branch: l.outputBranch } : {}),
    }));
}

export function buildReplanPrompt(request: string, outcomes: LeafOutcome[]): string {
  return [
    `The request was: ${request}`,
    '',
    'This work has finished:',
    ...outcomes.map((o) => [
      `- ${o.title} — ${o.status}${o.verified ? ', verified' : ', unverified'}${o.persona ? `, by ${o.persona}` : ''}`,
      ...(o.findings ? [`  what it found: ${o.findings}`] : []),
      ...(o.summary && !o.findings ? [`  it reported: ${o.summary}`] : []),
      ...(o.branch ? [`  landed on: ${o.branch}`] : []),
    ].join('\n')),
    '',
    'Given what actually came back — not what was planned — is any further work needed to satisfy',
    'the request? Something may now be possible that was not before, or an approach may have turned',
    'out not to work.',
    '',
    'If yes, propose it with propose_leaf, assigning a persona to each. If nothing further is needed,',
    'say so in one sentence and propose nothing. Do not re-propose work that already succeeded.',
  ].join('\n');
}
