import type { ClusterAccess } from '../infrastructure/index.js';

type Target = Parameters<ClusterAccess['helm']>[0];

export async function applyChartCrds(access: Pick<ClusterAccess, 'helm' | 'apply'>, target: Target, chart: { chart: string; version: string }, repo: string): Promise<void> {
  const crds = await access.helm(target, ['show', 'crds', chart.chart, '--repo', repo, '--version', chart.version]);
  await access.apply(target, crds, { serverSide: true });
}
