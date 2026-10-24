import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { ReleaseCatalogue } from './ReleaseCatalogue.js';

let db: MongoDB;
let repo: string;
let chartsDir: string;
let chart: string;

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });

beforeEach(async () => {
  db = await testDatabase();
  const root = mkdtempSync(join(tmpdir(), 'release-catalogue-'));
  repo = join(root, 'repo');
  chartsDir = join(root, 'charts');
  chart = join(root, 'instance-0.1.0.tgz');
  writeFileSync(chart, 'the chart');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
});

const catalogue = (imageTag: string, at: string) => new ReleaseCatalogue(db.instances, { repoRoot: repo, chartsDir, imageTag, chart: async () => chart }, () => new Date(at));

describe('the releases root has run', () => {
  it('records a tagged release with its notes, keeps when it was first served, and keeps its chart', async () => {
    git('tag', '-a', 'v2026.10.25', '-m', 'v2026.10.25\n\nHotfix released from aaaaaaaaaaaa after v2026.10.24 without the gates: typecheck and the image build.');
    expect(await catalogue('aaaaaaaaaaaa', '2026-10-25T00:00:00.000Z').recordCurrent()).toEqual({
      imageTag: 'aaaaaaaaaaaa', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', hotfix: true,
      notes: 'Hotfix released from aaaaaaaaaaaa after v2026.10.24 without the gates: typecheck and the image build.',
    });
    const again = catalogue('aaaaaaaaaaaa', '2026-10-27T00:00:00.000Z');
    expect((await again.recordCurrent()).servedAt).toBe('2026-10-25T00:00:00.000Z');
    expect(readFileSync(again.chartFile('aaaaaaaaaaaa')!, 'utf8')).toBe('the chart');
    expect(again.hasChart('bbbbbbbbbbbb')).toBe(false);
    expect(again.chartFile('../../etc/passwd')).toBeUndefined();
  });

  it('records a build no tag names under its image tag, and lists every release', async () => {
    await catalogue('aaaaaaaaaaaa', '2026-10-25T00:00:00.000Z').recordCurrent();
    git('tag', '-a', 'v2026.10.26', '-m', 'v2026.10.26\n\nShipped and released from bbbbbbbbbbbb after v2026.10.25: release-live.');
    const now = catalogue('bbbbbbbbbbbb', '2026-10-26T00:00:00.000Z');
    await now.recordCurrent();
    expect((await now.releases()).map((release) => [release.imageTag, release.version, release.hotfix ?? false])).toEqual([
      ['aaaaaaaaaaaa', 'aaaaaaaaaaaa', false],
      ['bbbbbbbbbbbb', 'v2026.10.26', false],
    ]);
    expect(existsSync(join(chartsDir, 'bbbbbbbbbbbb.tgz'))).toBe(true);
  });
});
