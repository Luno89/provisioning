import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const head = () => git('rev-parse', 'HEAD').slice(0, 12);
const commit = (name: string) => {
  writeFileSync(join(repo, `${name}.txt`), name);
  git('add', '.');
  git('commit', '-q', '-m', name);
  return head();
};

beforeEach(async () => {
  db = await testDatabase();
  const root = mkdtempSync(join(tmpdir(), 'release-catalogue-'));
  repo = join(root, 'repo');
  chartsDir = join(root, 'charts');
  chart = join(root, 'instance-0.1.0.tgz');
  writeFileSync(chart, 'the chart');
  execFileSync('git', ['init', '-q', repo]);
  commit('one');
});

const catalogue = (imageTag: string, at: string, imageDigest?: string) => new ReleaseCatalogue(db.instances, { repoRoot: repo, chartsDir, imageTag, imageDigest, chart: async () => chart }, () => new Date(at));
const chartSha256 = createHash('sha256').update('the chart').digest('hex');

describe('the releases root has run', () => {
  it('records a tagged release with its notes, keeps when it was first served, and keeps its chart', async () => {
    const one = head();
    git('tag', '-a', 'v2026.10.25', '-m', `v2026.10.25\n\nHotfix released from ${one} after v2026.10.24 without the gates: typecheck and the image build.`);
    expect(await catalogue(one, '2026-10-25T00:00:00.000Z').recordCurrent()).toEqual({
      imageTag: one, version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', hotfix: true,
      notes: `Hotfix released from ${one} after v2026.10.24 without the gates: typecheck and the image build.`, chartSha256,
    });
    const again = catalogue(one, '2026-10-27T00:00:00.000Z');
    expect((await again.recordCurrent()).servedAt).toBe('2026-10-25T00:00:00.000Z');
    expect(readFileSync(again.chartFile(one)!, 'utf8')).toBe('the chart');
    expect(again.hasChart('bbbbbbbbbbbb')).toBe(false);
    expect(again.chartFile('../../etc/passwd')).toBeUndefined();
  });

  it('records a build no tag names under its image tag, and lists every release', async () => {
    const one = head();
    await catalogue(one, '2026-10-25T00:00:00.000Z').recordCurrent();
    const two = commit('two');
    git('tag', '-a', 'v2026.10.26', '-m', `v2026.10.26\n\nShipped and released from ${two} after v2026.10.25: release-live.`);
    const now = catalogue(two, '2026-10-26T00:00:00.000Z');
    await now.recordCurrent();
    expect((await now.releases()).map((release) => [release.imageTag, release.version, release.hotfix ?? false])).toEqual([
      [one, one, false],
      [two, 'v2026.10.26', false],
    ]);
    expect(existsSync(join(chartsDir, `${two}.tgz`))).toBe(true);
  });

  it('names an image built from another commit by its image tag, and vouches for no digest, whatever the checkout carries', async () => {
    git('tag', '-a', 'v2026.10.26', '-m', `v2026.10.26\n\nShipped and released from ${head()} after v2026.10.25: release-live.`);
    const elsewhere = catalogue('nothing-here', '2026-10-26T00:00:00.000Z', `sha256:${'c'.repeat(64)}`);
    expect(await elsewhere.recordCurrent()).toEqual(expect.objectContaining({ imageTag: 'nothing-here', version: 'nothing-here' }));
    expect((await elsewhere.releases())[0]?.digest).toBeUndefined();
  });

  it('keeps the digest the image was released under and the chart\'s sha256, and answers only once they are recorded', async () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const one = head();
    const now = catalogue(one, '2026-10-25T00:00:00.000Z', digest);
    void now.recordCurrent();
    expect(await now.releases()).toEqual([expect.objectContaining({ imageTag: one, digest, chartSha256 })]);
    const unpinned = catalogue(one, '2026-10-26T00:00:00.000Z', 'latest');
    await unpinned.recordCurrent();
    expect((await unpinned.releases())[0]?.digest).toBeUndefined();
  });

  it('withdraws every release newer than the one root boots onto, and clears it when root moves onto one again', async () => {
    const one = head();
    await catalogue(one, '2026-10-25T00:00:00.000Z').recordCurrent();
    const two = commit('two');
    await catalogue(two, '2026-10-26T00:00:00.000Z').recordCurrent();
    const three = commit('three');
    await catalogue(three, '2026-10-27T00:00:00.000Z').recordCurrent();

    const back = await catalogue(one, '2026-10-28T00:00:00.000Z').recordCurrent();
    expect(back.withdrawn).toBeUndefined();
    const withdrawn = Object.fromEntries((await db.instances.getReleases()).map((release) => [release.imageTag, release.withdrawn]));
    expect(withdrawn).toEqual({ [one]: undefined, [two]: { at: '2026-10-28T00:00:00.000Z', by: `root rolled back to ${one}` }, [three]: { at: '2026-10-28T00:00:00.000Z', by: `root rolled back to ${one}` } });

    await catalogue(one, '2026-10-29T00:00:00.000Z').recordCurrent();
    expect((await db.instances.getReleases()).find((release) => release.imageTag === two)?.withdrawn?.at).toBe('2026-10-28T00:00:00.000Z');

    const forward = await catalogue(two, '2026-10-30T00:00:00.000Z').recordCurrent();
    expect(forward.withdrawn).toBeUndefined();
    const after = Object.fromEntries((await db.instances.getReleases()).map((release) => [release.imageTag, release.withdrawn?.by]));
    expect(after).toEqual({ [one]: undefined, [two]: undefined, [three]: `root rolled back to ${one}` });
  });
});
