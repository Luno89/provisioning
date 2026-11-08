import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Processes } from '../../platform/lib/processes.js';
import { InstanceChart, releaseInventory } from './InstanceChart.js';
import type { ClusterAccess } from '../../infrastructure/index.js';

const repoWith = (chartYaml?: string): string => {
  const repo = mkdtempSync(join(tmpdir(), 'instance-chart-repo-'));
  mkdirSync(join(repo, 'charts/instance'), { recursive: true });
  if (chartYaml !== undefined) writeFileSync(join(repo, 'charts/instance/Chart.yaml'), chartYaml);
  return repo;
};

const packaging = (repo: string, wrote: string | undefined) => {
  const charts = mock<Pick<ClusterAccess, 'packageChart'>>();
  charts.packageChart.calledWith(resolve(repo, 'charts/instance'), matches<string>((out) => out.length > 0)).mockImplementation(async (_chart, out) => {
    if (wrote) writeFileSync(join(out, wrote), 'chart');
  });
  return charts;
};

describe('the instance chart root serves', () => {
  it('reads its version from Chart.yaml', async () => {
    expect(await new InstanceChart(repoWith('name: instance\nversion: 0.4.2\n'), mock<Pick<ClusterAccess, 'packageChart'>>()).version()).toBe('0.4.2');
  });

  it('calls it 0.0.0 when Chart.yaml names no version', async () => {
    expect(await new InstanceChart(repoWith('name: instance\n'), mock<Pick<ClusterAccess, 'packageChart'>>()).version()).toBe('0.0.0');
  });

  it('packages the chart with helm once and hands back the same file each time', async () => {
    const repo = repoWith();
    const charts = packaging(repo, 'instance-0.4.2.tgz');
    const chart = new InstanceChart(repo, charts);
    const file = await chart.path();
    expect(file.endsWith('instance-0.4.2.tgz')).toBe(true);
    expect(await chart.path()).toBe(file);
    expect(charts.packageChart).toHaveBeenCalledTimes(1);
  });

  it('fails when helm writes no chart, and packages again the next time it is asked', async () => {
    const repo = repoWith();
    const charts = packaging(repo, undefined);
    const chart = new InstanceChart(repo, charts);
    await expect(chart.path()).rejects.toThrow('helm package wrote no chart');
    await expect(chart.path()).rejects.toThrow('helm package wrote no chart');
    expect(charts.packageChart).toHaveBeenCalledTimes(2);
  });
});

describe('the inventory of what a release is made of', () => {
  it('has the repository\'s script write it where it is told', async () => {
    const processes = mock<Processes>();
    processes.run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await releaseInventory('/repo', 'v2026.10.30', '/out/sbom.json', processes);
    expect(processes.run).toHaveBeenCalledWith({ command: process.execPath, args: ['/repo/scripts/deps-inventory.mjs', '--release', 'v2026.10.30', '--out', '/out/sbom.json'], cwd: '/repo' });
  });
});
