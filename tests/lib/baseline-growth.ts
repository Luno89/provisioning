import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type BaselineGrant, type Decision, DECISIONS } from '../alignment/decisions.js';

export type Baseline = Record<string, number>;

export type Suppressions = Record<string, Record<string, { count: number }>>;

export const SUPPRESSION_FILES = [
  'apps/backend',
  'apps/frontend',
  'apps/local-agent',
  'packages/agent-engine',
  'packages/cdktf-infra',
  'packages/context-engine',
  'packages/engine-core',
].map((workspace) => `${workspace}/eslint-suppressions.json`);

export function flattenSuppressions(suppressions: Suppressions): Baseline {
  const flat: Baseline = {};
  for (const [file, rules] of Object.entries(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) flat[`${rule} ${file}`] = count;
  }
  return flat;
}

export const STAGED: ReadonlyArray<{ path: string; by: 'rule' | 'total'; flat?: true }> = [
  ...SUPPRESSION_FILES.map((path) => ({ path, by: 'rule' as const, flat: true as const })),
  { path: 'tests/copies/baseline.json', by: 'rule' },
  { path: 'tests/coupling/untested.json', by: 'total' },
  { path: 'tests/tiers/slow.json', by: 'total' },
];

const sum = (baseline: Baseline): number => Object.values(baseline).reduce((total, count) => total + count, 0);

export function grownTotal(before: Baseline, after: Baseline): string[] {
  return sum(after) > sum(before) ? [`grew from ${sum(before)} to ${sum(after)}`] : [];
}

const totals = (baseline: Baseline): Map<string, number> => {
  const by = new Map<string, number>();
  for (const [key, count] of Object.entries(baseline)) {
    const rule = key.split(' ')[0] ?? key;
    by.set(rule, (by.get(rule) ?? 0) + count);
  }
  return by;
};

export const grants = (decisions: readonly Decision[]): BaselineGrant[] => decisions.flatMap((decision) => decision.grows ?? []);

export function grown(path: string, before: Baseline, after: Baseline, granted: readonly BaselineGrant[]): string[] {
  const was = totals(before);
  return [...totals(after)].flatMap(([rule, now]) => {
    const from = was.get(rule) ?? 0;
    if (now <= from) return [];
    const grant = granted.find((one) => one.path === path && one.rule === rule && one.from === from);
    if (!grant) return [`${rule} grew from ${from} to ${now}`];
    return now > grant.to ? [`${rule} grew from ${from} to ${now}, past the ${grant.to} the register allows`] : [];
  });
}

function shown(root: string, spec: string, flat: boolean): Baseline | undefined {
  const read = spawnSync('git', ['-C', root, 'show', spec], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (read.status !== 0) return undefined;
  return flat ? flattenSuppressions(JSON.parse(read.stdout) as Suppressions) : JSON.parse(read.stdout) as Baseline;
}

export function stagedGrowth(root: string): string[] {
  return STAGED.flatMap(({ path, by, flat }) => {
    const before = shown(root, `HEAD:${path}`, flat === true);
    const after = shown(root, `:${path}`, flat === true);
    if (!before || !after) return [];
    return (by === 'total' ? grownTotal(before, after) : grown(path, before, after, grants(DECISIONS))).map((line) => `${path}: ${line}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const growth = stagedGrowth(process.cwd());
  if (growth.length > 0) {
    console.error(`a baseline only shrinks, and this commit grows one:\n${growth.map((line) => `  ${line}`).join('\n')}\nFix what the audit found instead. Growing a baseline needs the owner's yes, recorded in the decisions register.`);
    process.exitCode = 1;
  }
}
