import type { VerifyOutcome } from './leaf-verify.js';

export const MAX_EXTENSIONS = 2;

export const EXTENSION_FRACTION = 0.5;

export interface ProgressSample {
  at: { step: number; tokens: number };
  verify?: VerifyOutcome | undefined;
  missingArtifacts?: number | undefined;
  commits?: number | undefined;
  changedLines?: number | undefined;
  findingsChars?: number | undefined;
  findingsOutcome?: VerifyOutcome | undefined;
}

export interface ProgressEvidence {
  moved: boolean;
  reasons: string[];
  churnOnly: boolean;
}

const MEANINGFUL_LINES = 10;

export function compareProgress(
  previous: ProgressSample | undefined,
  current: ProgressSample,
): ProgressEvidence {
  if (!previous) return { moved: false, reasons: [], churnOnly: false };

  const reasons: string[] = [];
  let strong = false;

  if (current.verify === 'passed' && previous?.verify !== 'passed') {
    reasons.push('its tests now pass');
    strong = true;
  }

  const wasMissing = previous?.missingArtifacts;
  const nowMissing = current.missingArtifacts;
  if (typeof nowMissing === 'number' && typeof wasMissing === 'number' && nowMissing < wasMissing) {
    reasons.push(`${wasMissing - nowMissing} more of the files it promised now exist`);
    strong = true;
  }

  if (current.findingsOutcome === 'passed' && previous?.findingsOutcome !== 'passed') {
    reasons.push('its answer now meets the bar');
    strong = true;
  } else if (
    typeof current.findingsChars === 'number'
    && typeof previous?.findingsChars === 'number'
    && current.findingsChars > previous.findingsChars * 1.2
  ) {
    reasons.push('its answer grew substantially');
    strong = true;
  }

  if (typeof current.commits === 'number' && current.commits > (previous?.commits ?? 0)) {
    reasons.push(`${current.commits - (previous?.commits ?? 0)} new commits`);
    strong = true;
  }

  let churnOnly = false;
  if (!reasons.length) {
    const lines = (current.changedLines ?? 0) - (previous?.changedLines ?? 0);
    if (lines >= MEANINGFUL_LINES) {
      reasons.push(`${lines} lines changed since the last check`);
      churnOnly = true;
    }
  }

  return { moved: reasons.length > 0, reasons, churnOnly: churnOnly && !strong };
}

export interface ExtensionState {
  exhausted: 'steps' | 'tokens';
  extensionsUsed: number;
  evidence: ProgressEvidence;
  thrashing: boolean;
  circling: boolean;
  silent: boolean;
  originalMaxSteps: number;
  originalMaxTokens: number;
  headroomTokens?: number | undefined;
}

export interface Extension {
  steps?: number;
  tokens?: number;
  reason: string;
}

export function refusalReason(state: ExtensionState): string | undefined {
  if (state.thrashing) return 'the run is thrashing — more room is the wrong answer';
  if (state.circling) return 'the run is repeating itself';
  if (state.silent) return 'the run stopped calling tools';
  if (state.extensionsUsed >= MAX_EXTENSIONS) return `already extended ${MAX_EXTENSIONS} times`;
  if (!state.evidence.moved) return 'nothing measurable moved';
  if (state.evidence.churnOnly && state.extensionsUsed >= 1) {
    return 'only file churn to show, and it has already been extended once';
  }
  if (state.exhausted === 'tokens') {
    const wanted = Math.ceil(state.originalMaxTokens * EXTENSION_FRACTION);
    const grant = typeof state.headroomTokens === 'number'
      ? Math.min(wanted, Math.max(0, state.headroomTokens))
      : wanted;
    if (grant < 2_000) return 'the request budget has nothing meaningful left to give';
  }
  return undefined;
}

export function decideExtension(state: ExtensionState): Extension | undefined {
  if (state.thrashing || state.circling || state.silent) return undefined;

  if (state.extensionsUsed >= MAX_EXTENSIONS) return undefined;
  if (!state.evidence.moved) return undefined;

  if (state.evidence.churnOnly && state.extensionsUsed >= 1) return undefined;

  const reason = `granted because ${state.evidence.reasons.join(', and ')}`;

  if (state.exhausted === 'steps') {
    return { steps: Math.ceil(state.originalMaxSteps * EXTENSION_FRACTION), reason };
  }

  const wanted = Math.ceil(state.originalMaxTokens * EXTENSION_FRACTION);
  const grant = typeof state.headroomTokens === 'number'
    ? Math.min(wanted, Math.max(0, state.headroomTokens))
    : wanted;

  if (grant < 2_000) return undefined;

  return { tokens: grant, reason };
}

export function extensionNotice(extension: Extension, newCeiling: number, unit: 'steps' | 'tokens'): string {
  return [
    `Your budget has been extended to ${newCeiling.toLocaleString()} ${unit} — ${extension.reason}.`,
    '',
    'Ignore any earlier statement of your budget; this is the number that applies now. Carry on with',
    'what was working. Do not start over, and do not spend the extra room re-checking what you have',
    'already done.',
  ].join('\n');
}
