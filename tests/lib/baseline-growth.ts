import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export type Baseline = Record<string, number>;

export const STAGED: ReadonlyArray<{ path: string; by: 'rule' | 'total' }> = [
  { path: 'tests/copies/baseline.json', by: 'rule' },
  { path: 'tests/coupling/untested.json', by: 'total' },
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

export function grown(before: Baseline, after: Baseline): string[] {
  const was = totals(before);
  return [...totals(after)].filter(([rule, now]) => now > (was.get(rule) ?? 0)).map(([rule, now]) => `${rule} grew from ${was.get(rule) ?? 0} to ${now}`);
}

function shown(root: string, spec: string): Baseline | undefined {
  const read = spawnSync('git', ['-C', root, 'show', spec], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return read.status === 0 ? JSON.parse(read.stdout) as Baseline : undefined;
}

export function stagedGrowth(root: string): string[] {
  return STAGED.flatMap(({ path, by }) => {
    const before = shown(root, `HEAD:${path}`);
    const after = shown(root, `:${path}`);
    if (!before || !after) return [];
    return (by === 'total' ? grownTotal(before, after) : grown(before, after)).map((line) => `${path}: ${line}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const growth = stagedGrowth(process.cwd());
  if (growth.length > 0) {
    console.error(`a baseline only shrinks, and this commit grows one:\n${growth.map((line) => `  ${line}`).join('\n')}\nFix what the audit found instead. Growing a baseline needs the owner's yes, recorded in the decisions register.`);
    process.exitCode = 1;
  }
}
