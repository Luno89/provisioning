import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { RanRange } from './collect.js';
import { chartEnvSites } from './env-edges.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HELM = join(ROOT, 'bin', 'helm');

export function renderChart(release: string, chart: string, args: readonly string[]): string {
  const rendered = execFileSync(HELM, ['template', release, chart, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const trace = process.env.COUPLING_CHART_TRACE;
  if (trace) {
    const sites = chartEnvSites(rendered, ROOT, relative(ROOT, resolve(chart)));
    appendFileSync(trace, [...sites.values()].map((site) => `${site.file}:${site.line}\n`).join(''));
  }
  return rendered;
}

export function chartRan(trace: string): Record<string, RanRange[]> {
  if (!existsSync(trace)) return {};
  const counts = new Map<string, Map<number, number>>();
  for (const entry of readFileSync(trace, 'utf8').split('\n')) {
    const at = /^(.+):(\d+)$/.exec(entry);
    if (!at) continue;
    const lines = counts.get(at[1]!) ?? new Map<number, number>();
    lines.set(Number(at[2]), (lines.get(Number(at[2])) ?? 0) + 1);
    counts.set(at[1]!, lines);
  }
  return Object.fromEntries([...counts].map(([file, lines]) => [file, [...lines].sort(([a], [b]) => a - b).map(([line, count]) => ({ start: { line, column: 1 }, end: { line, column: Number.MAX_SAFE_INTEGER }, count }))]));
}
