import type { RunOutcome, OutcomeCounts, VariantResult } from '@koala/harness-types';

export type { RunOutcome, OutcomeCounts };

function neverRan(result: VariantResult): boolean {
  return result.steps === 0 && result.tokensUsed === 0;
}

function exhausted(result: VariantResult): boolean {
  if ((result as { outOfBudget?: boolean }).outOfBudget) return !result.succeeded;
  const cap = result.request?.loop?.maxSteps;
  return cap !== undefined && result.steps >= cap && !result.succeeded;
}

export function classifyOutcome(result: VariantResult): RunOutcome {
  if (result.error || neverRan(result)) return 'broken';
  if (result.verified) return 'verified';
  if (exhausted(result)) return 'incomplete';
  return 'wrong';
}

export function countOutcomes(results: VariantResult[]): OutcomeCounts {
  const counts: OutcomeCounts = { verified: 0, wrong: 0, incomplete: 0, broken: 0 };
  for (const r of results) counts[classifyOutcome(r)] += 1;
  return counts;
}

export function attempted(results: VariantResult[]): VariantResult[] {
  return results.filter((r) => classifyOutcome(r) !== 'broken');
}

export function claimGap(results: VariantResult[]): { overclaimed: VariantResult[]; underclaimed: VariantResult[] } {
  const fair = attempted(results);
  return {
    overclaimed: fair.filter((r) => r.succeeded && !r.verified),
    underclaimed: fair.filter((r) => !r.succeeded && r.verified),
  };
}

export function droppedOverrides(result: VariantResult): string[] {
  const asked = result.request?.overrides;
  if (!asked) return [];
  const sent = result.request?.parameters ?? {};
  const loop = result.request?.loop ?? {};
  const unsupported = new Set(result.request?.unsupported ?? []);

  const prompt = result.request?.systemPrompt ?? '';

  return Object.keys(asked)
    .filter((key) => !unsupported.has(key))
    .filter((key) => {
      if (key in sent) return false;
      if (key in loop) return false;
      const value = (asked as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() && prompt.includes(value.trim())) return false;
      const vars = (sent as Record<string, unknown>).template_vars;
      if (vars && typeof vars === 'object' && Object.keys(vars).length) {
        if (key === 'think' && 'enable_thinking' in (vars as Record<string, unknown>)) return false;
      }
      return true;
    })
    .sort();
}
