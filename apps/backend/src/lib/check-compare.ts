import type { ScenarioResult } from '../eval/level2/results.js';

export interface ComparableCheckRun {
  id: string;
  startedAt: string;
  modelId?: string | undefined;
  modelLabel?: string | undefined;
  sampling?: unknown;
  trialPractice?: string | undefined;
  promptOverride?: { agent: string; prompt: string } | undefined;
  agents?: Record<string, string> | undefined;
  results: ScenarioResult[];
}

export interface Rate {
  passed: number;
  attempts: number;
}

export interface CheckDelta {
  id: string;
  name: string;
  before?: Rate | undefined;
  after?: Rate | undefined;
  change: number | undefined;
}

export interface ToolDelta {
  tool: string;
  before: Rate;
  after: Rate;
  change: number;
}

export interface RunDifference {
  what: string;
  before: string;
  after: string;
}

export interface CheckRunComparison {
  before: string;
  after: string;
  differences: RunDifference[];
  checks: CheckDelta[];
  tools: ToolDelta[];
}

export const NO_TOOL = '(answers without calling anything)';

export const rateOf = (result: ScenarioResult): Rate => (result.attempts
  ? { passed: result.attempts.filter((attempt) => attempt.passed).length, attempts: result.attempts.length }
  : { passed: result.passed ? 1 : 0, attempts: 1 });

const ratio = (rate: Rate): number => (rate.attempts === 0 ? 0 : rate.passed / rate.attempts);

const shown = (value: unknown): string => (value === undefined ? 'not set' : typeof value === 'string' ? value : JSON.stringify(value));

export function compareCheckRuns(before: ComparableCheckRun, after: ComparableCheckRun, chosen: (checkId: string) => string | null | undefined): CheckRunComparison {
  const differences: RunDifference[] = [];
  const note = (what: string, a: unknown, b: unknown) => {
    if (shown(a) !== shown(b)) differences.push({ what, before: shown(a), after: shown(b) });
  };
  note('model', before.modelLabel ?? before.modelId, after.modelLabel ?? after.modelId);
  note('sampling', before.sampling, after.sampling);
  note('practice on trial', before.trialPractice, after.trialPractice);
  note('prompt tried', before.promptOverride && `${before.promptOverride.agent}'s`, after.promptOverride && `${after.promptOverride.agent}'s`);
  for (const agent of [...new Set([...Object.keys(before.agents ?? {}), ...Object.keys(after.agents ?? {})])].sort()) {
    const a = before.agents?.[agent];
    const b = after.agents?.[agent];
    if (a && b && a !== b) differences.push({ what: `${agent}'s setup`, before: 'as it was', after: 'changed — its prompt, tools or procedure' });
  }

  const beforeChecks = new Map(before.results.map((result) => [result.scenarioId, result]));
  const afterChecks = new Map(after.results.map((result) => [result.scenarioId, result]));
  const checks = [...new Set([...beforeChecks.keys(), ...afterChecks.keys()])].map((id): CheckDelta => {
    const a = beforeChecks.get(id);
    const b = afterChecks.get(id);
    const beforeRate = a ? rateOf(a) : undefined;
    const afterRate = b ? rateOf(b) : undefined;
    return {
      id,
      name: (b ?? a)!.name,
      ...(beforeRate ? { before: beforeRate } : {}),
      ...(afterRate ? { after: afterRate } : {}),
      change: beforeRate && afterRate ? ratio(afterRate) - ratio(beforeRate) : undefined,
    };
  }).sort((x, y) => (x.change ?? 0) - (y.change ?? 0) || x.id.localeCompare(y.id));

  const shared = [...beforeChecks.keys()].filter((id) => afterChecks.has(id) && chosen(id) !== undefined);
  const byTool = (results: Map<string, ScenarioResult>) => {
    const rates = new Map<string, Rate>();
    for (const id of shared) {
      const tool = chosen(id) ?? NO_TOOL;
      const rate = rateOf(results.get(id)!);
      const sum = rates.get(tool) ?? { passed: 0, attempts: 0 };
      rates.set(tool, { passed: sum.passed + rate.passed, attempts: sum.attempts + rate.attempts });
    }
    return rates;
  };
  const beforeTools = byTool(beforeChecks);
  const afterTools = byTool(afterChecks);
  const tools = [...beforeTools.keys()].map((tool): ToolDelta => {
    const a = beforeTools.get(tool)!;
    const b = afterTools.get(tool)!;
    return { tool, before: a, after: b, change: ratio(b) - ratio(a) };
  }).sort((x, y) => x.change - y.change || x.tool.localeCompare(y.tool));

  return { before: before.id, after: after.id, differences, checks, tools };
}
