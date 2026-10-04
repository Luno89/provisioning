import { createHash } from 'node:crypto';

export interface BenchSettings {
  enabled: boolean;
  idleMinutes: number;
  fullEveryHours: number;
}

export const DEFAULT_BENCH_SETTINGS: BenchSettings = { enabled: true, idleMinutes: 15, fullEveryHours: 24 };

export interface BenchState {
  ownerId: string;
  benched: Record<string, string>;
  lastFullAt?: string | undefined;
}

export type BenchTrigger =
  | { kind: 'manual' }
  | { kind: 'full' }
  | { kind: 'changed'; agents: string[] }
  | { kind: 'practice'; agent: string; practiceId: string }
  | { kind: 'prompt-change'; agent: string; changeId: string };

export interface BenchPlan {
  trigger: Exclude<BenchTrigger, { kind: 'manual' }>;
  scenarioIds: string[];
}

export function benchSettingsProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['bench settings have to be an object'];
  const settings = value as Partial<BenchSettings>;
  const problems: string[] = [];
  if (typeof settings.enabled !== 'boolean') problems.push('say whether the bench runs on its own (enabled: true or false)');
  if (!(typeof settings.idleMinutes === 'number' && settings.idleMinutes > 0)) problems.push('idleMinutes is how long the model has to be idle first, a number greater than zero');
  if (!(typeof settings.fullEveryHours === 'number' && settings.fullEveryHours > 0)) problems.push('fullEveryHours is how often every scenario runs, a number of hours greater than zero');
  return problems;
}

export function benchPlan(
  scenarios: readonly { id: string; agent: string }[],
  fingerprints: Readonly<Record<string, string>>,
  state: BenchState,
  settings: BenchSettings,
  now: number,
): BenchPlan | undefined {
  if (!settings.enabled || scenarios.length === 0) return undefined;
  const fullDue = !state.lastFullAt || now - Date.parse(state.lastFullAt) >= settings.fullEveryHours * 3_600_000;
  if (fullDue) return { trigger: { kind: 'full' }, scenarioIds: scenarios.map((scenario) => scenario.id) };

  const changed = scenarios.filter((scenario) => fingerprints[scenario.agent] !== undefined && fingerprints[scenario.agent] !== state.benched[scenario.agent]);
  if (changed.length === 0) return undefined;
  return {
    trigger: { kind: 'changed', agents: [...new Set(changed.map((scenario) => scenario.agent))].sort() },
    scenarioIds: changed.map((scenario) => scenario.id),
  };
}

export function regressionsIn(
  current: readonly { scenarioId: string; passed: boolean }[],
  earlier: readonly { results: readonly { scenarioId: string; passed: boolean }[] }[],
): string[] {
  return current
    .filter((result) => !result.passed)
    .filter((result) => {
      for (const run of earlier) {
        const before = run.results.find((entry) => entry.scenarioId === result.scenarioId);
        if (before) return before.passed;
      }
      return false;
    })
    .map((result) => result.scenarioId);
}

export function fingerprintOf(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}
