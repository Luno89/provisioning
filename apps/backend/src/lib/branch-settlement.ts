import type { Branch, Leaf } from './leaves.js';

const LIVE = new Set(['proposed', 'pending', 'running']);

export interface Settlement {
  settled: boolean;
  delivered: Leaf[];
  claimed: Leaf[];
  outstanding: Leaf[];
  live: Leaf[];
}

export function settlementOf(leaves: Leaf[]): Settlement {
  const live = leaves.filter((l) => LIVE.has(l.status));
  const succeeded = leaves.filter((l) => l.status === 'succeeded');
  return {
    settled: live.length === 0 && leaves.length > 0,
    delivered: succeeded.filter((l) => l.verified === true),
    claimed: succeeded.filter((l) => l.verified !== true),
    outstanding: leaves.filter((l) => l.status === 'failed'),
    live,
  };
}

export const MAX_EVIDENCE_CHARS = 160;

export function evidenceFor(leaf: Leaf): string {
  const clip = (t: string) => {
    const flat = t.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_EVIDENCE_CHARS ? `${flat.slice(0, MAX_EVIDENCE_CHARS - 1)}…` : flat;
  };

  if (leaf.status === 'failed') {
    const attempts = Array.isArray(leaf.attempts) ? leaf.attempts : [];
    const last = attempts[attempts.length - 1]?.error;
    const count = attempts.length
      ? `failed after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`
      : 'failed';
    return last ? `${count} — last error: ${clip(last)}` : count;
  }

  if (leaf.status === 'cancelled') return 'stopped deliberately';
  if (leaf.status === 'running') return 'running now';
  if (leaf.status === 'pending') return 'accepted, waiting its turn';
  if (leaf.status === 'proposed') return 'proposed, awaiting a decision';

  const check = leaf.expects?.length
    ? `produced ${leaf.expects.join(', ')}`
    : leaf.verifyCommand
      ? `passed \`${clip(leaf.verifyCommand)}\``
      : 'a check passed';

  if (!leaf.verified) {
    return leaf.merged
      ? 'the agent reported success and it merged; nothing checked it'
      : 'the agent reported success; nothing checked it';
  }

  if (leaf.merged) return `${check}, merged to the default branch`;
  if (leaf.outputBranch) return `${check}, pushed to ${leaf.outputBranch} but NOT merged`;
  return check;
}

export function summariseBranch(branch: Pick<Branch, 'title' | 'acceptanceOutcome'>, s: Settlement): string {
  if (!s.settled) return '';
  const parts: string[] = [];
  if (s.delivered.length) parts.push(`${s.delivered.length} delivered`);
  if (s.claimed.length) parts.push(`${s.claimed.length} claimed but unchecked`);
  if (s.outstanding.length) parts.push(`${s.outstanding.length} not delivered`);
  const counts = parts.length ? parts.join(', ') : 'nothing finished';
  const verdict = branch.acceptanceOutcome === 'passed' ? '; acceptance passed'
    : branch.acceptanceOutcome === 'failed' ? '; acceptance failed'
      : '';
  return `"${branch.title}" — ${counts}${verdict}`;
}

export function citedSummary(branch: Pick<Branch, 'title' | 'acceptanceOutcome' | 'acceptanceFailedCheck'>, s: Settlement): string[] {
  if (!s.settled) return [];
  const lines = [summariseBranch(branch, s)];

  if (branch.acceptanceOutcome === 'failed' && branch.acceptanceFailedCheck) {
    lines.push(`    acceptance stopped at: ${branch.acceptanceFailedCheck}`);
  }
  for (const leaf of s.outstanding) {
    lines.push(`    not delivered — ${leaf.title}: ${evidenceFor(leaf)}`);
  }
  if (s.claimed.length) {
    for (const leaf of s.claimed) lines.push(`    unchecked — ${leaf.title}: ${evidenceFor(leaf)}`);
  }
  return lines;
}

export interface ProjectStanding {
  finishedLines: string[];
  delivered: string[];
  outstanding: { title: string; attempts: number; from: string; evidence: string }[];
  liveBranches: { branch: Branch; leaves: Leaf[] }[];
}

export function projectStanding(branches: Branch[], leaves: Leaf[]): ProjectStanding {
  const finishedLines: string[] = [];
  const delivered: string[] = [];
  const outstanding: ProjectStanding['outstanding'] = [];
  const liveBranches: ProjectStanding['liveBranches'] = [];

  for (const branch of branches) {
    const mine = leaves.filter((l) => l.branchId === branch.id);
    if (!mine.length) continue;
    const s = settlementOf(mine);

    if (!s.settled) {
      liveBranches.push({ branch, leaves: mine });
      continue;
    }

    finishedLines.push(...citedSummary(branch, s));
    delivered.push(...[...s.delivered, ...s.claimed].map((l) => l.title));
    outstanding.push(...s.outstanding.map((l) => ({
      title: l.title,
      attempts: Array.isArray(l.attempts) ? l.attempts.length : 0,
      from: branch.title,
      evidence: evidenceFor(l),
    })));
  }

  return { finishedLines, delivered, outstanding, liveBranches };
}
