import type { Answer } from './answers.js';
import type { Finding } from './drift.js';
import { FOR_THE_OWNER } from './drift-page.js';

export interface Gate {
  open: Finding[];
  asked: Finding[];
  noted: Finding[];
  stale: Answer[];
}

export function gateOf(findings: readonly Finding[], answers: readonly Answer[]): Gate {
  const byFinding = new Map(answers.map((answer) => [answer.finding, answer]));
  const forOwner = findings.filter((finding) => FOR_THE_OWNER.has(finding.kind));
  const ids = new Set(findings.map((finding) => finding.id));
  return {
    open: forOwner.filter((finding) => !byFinding.has(finding.id)),
    asked: forOwner.filter((finding) => byFinding.get(finding.id)?.state === 'asked'),
    noted: forOwner.filter((finding) => byFinding.get(finding.id)?.state === 'noted'),
    stale: answers.filter((answer) => !ids.has(answer.finding)),
  };
}

export function gateRefusal(gate: Gate): string | undefined {
  const lines = [
    ...gate.open.map((finding) => `  not asked: ${finding.title}${finding.steps.length ? ` (${finding.steps.join(', ')})` : ''}`),
    ...gate.stale.map((answer) => `  answered, but no longer found: ${answer.finding}; take it out of tests/alignment/answers.ts`),
  ];
  if (lines.length === 0) return undefined;
  return `the drift between what was agreed and what the code does has ${lines.length} thing${lines.length === 1 ? '' : 's'} the owner has not been asked about (npm run drift shows them):\n${lines.join('\n')}`;
}
