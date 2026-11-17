import { describe, expect, it } from 'vitest';
import { chartRepository } from '../../../../../packages/cdktf-infra/lib/chart-source.js';
import { chartRepositoryFor, helmArgsFor } from './chart-sources.js';

describe('where a chart repository is read from', () => {
  it('is the pinned address, or with CHART_SOURCES set, that address under the one standing in for every repository', () => {
    expect(chartRepositoryFor('https://prometheus-community.github.io/helm-charts', undefined)).toBe('https://prometheus-community.github.io/helm-charts');
    expect(chartRepositoryFor('https://prometheus-community.github.io/helm-charts', 'http://127.0.0.1:4100/')).toBe('http://127.0.0.1:4100/prometheus-community.github.io/helm-charts');
    expect(chartRepositoryFor('https://dl.gitea.com/charts/', 'http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100/dl.gitea.com/charts');
  });

  it('moves only the repository a helm command names, and changes nothing without CHART_SOURCES', () => {
    const args = ['upgrade', '--install', 'kps', 'kube-prometheus-stack', '--repo', 'https://charts.example.com', '--version', '1.0.0'];
    expect(helmArgsFor(args, undefined)).toEqual(args);
    expect(helmArgsFor(args, 'http://127.0.0.1:4100')).toEqual(['upgrade', '--install', 'kps', 'kube-prometheus-stack', '--repo', 'http://127.0.0.1:4100/charts.example.com', '--version', '1.0.0']);
    expect(helmArgsFor(['list', '-n', 'monitoring', '-o', 'json'], 'http://127.0.0.1:4100')).toEqual(['list', '-n', 'monitoring', '-o', 'json']);
  });
});

describe('the copy Terraform\'s charts read', () => {
  it('gives the same address as the backend\'s for every repository, with and without CHART_SOURCES', () => {
    for (const pinned of ['https://prometheus-community.github.io/helm-charts', 'https://dl.gitea.com/charts/', 'https://charts.loft.sh']) {
      for (const sources of [undefined, 'http://127.0.0.1:4100', 'http://127.0.0.1:4100/']) expect(chartRepository(pinned, sources)).toBe(chartRepositoryFor(pinned, sources));
    }
  });
});
