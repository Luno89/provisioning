import type { AttemptRecord } from './attempt.js';

export interface CaseResult {
  name: string;
  category: string;
  agent: string;
  expects: string | null;
  attempts: AttemptRecord[];
}

export interface ComparableRun {
  id: string;
  startedAt: string;
  modelId?: string | undefined;
  modelLabel?: string | undefined;
  sampling?: unknown;
  maxTokens?: number | undefined;
  toolCatalogueHash?: string | undefined;
  results: CaseResult[];
}

export interface Rate {
  passed: number;
  attempts: number;
}

export interface CaseDelta {
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

export interface RunComparison {
  before: string;
  after: string;
  differences: RunDifference[];
  cases: CaseDelta[];
  tools: ToolDelta[];
}

const rateOf = (result: CaseResult): Rate => ({
  passed: result.attempts.filter((attempt) => attempt.passed).length,
  attempts: result.attempts.length,
});

const ratio = (rate: Rate): number => (rate.attempts === 0 ? 0 : rate.passed / rate.attempts);

const promptsByAgent = (run: ComparableRun): Map<string, string> => {
  const prompts = new Map<string, Set<string>>();
  for (const result of run.results) {
    for (const attempt of result.attempts) {
      if (!attempt.systemHash) continue;
      prompts.set(result.agent, (prompts.get(result.agent) ?? new Set()).add(attempt.systemHash));
    }
  }
  return new Map([...prompts].map(([agent, hashes]) => [agent, [...hashes].sort().join(', ')]));
};

const shown = (value: unknown): string => (value === undefined ? 'not set' : typeof value === 'string' ? value : JSON.stringify(value));

export function compareRuns(before: ComparableRun, after: ComparableRun): RunComparison {
  const differences: RunDifference[] = [];
  const note = (what: string, a: unknown, b: unknown) => {
    if (shown(a) !== shown(b)) differences.push({ what, before: shown(a), after: shown(b) });
  };
  note('model', before.modelLabel ?? before.modelId, after.modelLabel ?? after.modelId);
  note('sampling', before.sampling, after.sampling);
  note('reply cap', before.maxTokens, after.maxTokens);
  note('tool catalogue', before.toolCatalogueHash, after.toolCatalogueHash);

  const beforePrompts = promptsByAgent(before);
  const afterPrompts = promptsByAgent(after);
  for (const agent of [...new Set([...beforePrompts.keys(), ...afterPrompts.keys()])].sort()) {
    note(`${agent}'s system prompt`, beforePrompts.get(agent), afterPrompts.get(agent));
  }

  const beforeCases = new Map(before.results.map((result) => [result.name, result]));
  const afterCases = new Map(after.results.map((result) => [result.name, result]));
  const cases = [...new Set([...beforeCases.keys(), ...afterCases.keys()])].map((name): CaseDelta => {
    const a = beforeCases.get(name);
    const b = afterCases.get(name);
    const beforeRate = a ? rateOf(a) : undefined;
    const afterRate = b ? rateOf(b) : undefined;
    return {
      name,
      ...(beforeRate ? { before: beforeRate } : {}),
      ...(afterRate ? { after: afterRate } : {}),
      change: beforeRate && afterRate ? ratio(afterRate) - ratio(beforeRate) : undefined,
    };
  }).sort((x, y) => (x.change ?? 0) - (y.change ?? 0) || x.name.localeCompare(y.name));

  const byTool = (run: ComparableRun, only: Set<string>) => {
    const rates = new Map<string, Rate>();
    for (const result of run.results) {
      if (!only.has(result.name)) continue;
      const tool = result.expects ?? '(answers without calling anything)';
      const rate = rateOf(result);
      const sum = rates.get(tool) ?? { passed: 0, attempts: 0 };
      rates.set(tool, { passed: sum.passed + rate.passed, attempts: sum.attempts + rate.attempts });
    }
    return rates;
  };
  const shared = new Set([...beforeCases.keys()].filter((name) => afterCases.has(name)));
  const beforeTools = byTool(before, shared);
  const afterTools = byTool(after, shared);
  const tools = [...beforeTools.keys()].map((tool): ToolDelta => {
    const a = beforeTools.get(tool)!;
    const b = afterTools.get(tool) ?? { passed: 0, attempts: 0 };
    return { tool, before: a, after: b, change: ratio(b) - ratio(a) };
  }).sort((x, y) => x.change - y.change || x.tool.localeCompare(y.tool));

  return { before: before.id, after: after.id, differences, cases, tools };
}
