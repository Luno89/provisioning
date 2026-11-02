import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matches, mockFn } from 'vitest-mock-extended';
import { InstanceChart, releaseInventory, type RunProgram } from './InstanceChart.js';

const repoWith = (chartYaml?: string): string => {
  const repo = mkdtempSync(join(tmpdir(), 'instance-chart-repo-'));
  mkdirSync(join(repo, 'charts/instance'), { recursive: true });
  if (chartYaml !== undefined) writeFileSync(join(repo, 'charts/instance/Chart.yaml'), chartYaml);
  return repo;
};

const packaging = (repo: string, wrote: string | undefined): RunProgram => {
  const run = mockFn<RunProgram>();
  run.calledWith(
    resolve(repo, 'bin/helm'),
    matches<string[]>((args) => args[0] === 'package' && args[1] === resolve(repo, 'charts/instance') && args[2] === '-d'),
    undefined,
  ).mockImplementation(async (_command, args) => {
    if (wrote) writeFileSync(join(args[3]!, wrote), 'chart');
    return {};
  });
  return run;
};

describe('the instance chart root serves', () => {
  it('reads its version from Chart.yaml', async () => {
    expect(await new InstanceChart(repoWith('name: instance\nversion: 0.4.2\n')).version()).toBe('0.4.2');
  });

  it('calls it 0.0.0 when Chart.yaml names no version', async () => {
    expect(await new InstanceChart(repoWith('name: instance\n')).version()).toBe('0.0.0');
  });

  it('packages the chart with helm once and hands back the same file each time', async () => {
    const repo = repoWith();
    const run = packaging(repo, 'instance-0.4.2.tgz');
    const chart = new InstanceChart(repo, run);
    const file = await chart.path();
    expect(file.endsWith('instance-0.4.2.tgz')).toBe(true);
    expect(await chart.path()).toBe(file);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails when helm writes no chart, and packages again the next time it is asked', async () => {
    const repo = repoWith();
    const run = packaging(repo, undefined);
    const chart = new InstanceChart(repo, run);
    await expect(chart.path()).rejects.toThrow('helm package wrote no chart');
    await expect(chart.path()).rejects.toThrow('helm package wrote no chart');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('the inventory of what a release is made of', () => {
  it('has the repository\'s script write it where it is told', async () => {
    const run = mockFn<RunProgram>();
    run.mockResolvedValue({});
    await releaseInventory('/repo', 'v2026.10.30', '/out/sbom.json', run);
    expect(run).toHaveBeenCalledWith(process.execPath, ['/repo/scripts/deps-inventory.mjs', '--release', 'v2026.10.30', '--out', '/out/sbom.json'], { cwd: '/repo' });
  });
});
