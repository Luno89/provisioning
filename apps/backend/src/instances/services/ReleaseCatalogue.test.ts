import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/index.js';
import type { ProcessRun, Processes } from '../../platform/lib/processes.js';
import { ReleaseCatalogue } from './ReleaseCatalogue.js';

let db: Database;
let repo: string;
let chartsDir: string;
let chart: string;
let inventoried: { release: string; out: string }[];

const FULL = (short: string): string => `${short}${'0'.repeat(40 - short.length)}\n`;

const asked = (...words: string[]) => matches<ProcessRun>((run) => run.command === 'git' && run.cwd === repo && run.args.join(' ') === words.join(' '));
const printed = (stdout: string) => ({ code: 0, stdout, stderr: '' });

function checkout(head: string, tag?: { name: string; message: string }): Processes {
  const git = mock<Processes>();
  git.run.calledWith(asked('rev-parse', 'HEAD')).mockResolvedValue(printed(FULL(head)));
  if (tag) {
    git.run.calledWith(asked('describe', '--exact-match', '--tags', '--match', 'v*', 'HEAD')).mockResolvedValue(printed(`${tag.name}\n`));
    git.run.calledWith(asked('tag', '--list', '--format=%(contents)', tag.name)).mockResolvedValue(printed(`${tag.message}\n`));
  } else {
    git.run.calledWith(asked('describe', '--exact-match', '--tags', '--match', 'v*', 'HEAD')).mockResolvedValue({ code: 128, stdout: '', stderr: 'fatal: no tag exactly matches' });
  }
  return git;
}

beforeEach(() => {
  inventoried = [];
  db = memoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 'release-catalogue-'));
  repo = join(root, 'repo');
  chartsDir = join(root, 'charts');
  chart = join(root, 'instance-0.1.0.tgz');
  writeFileSync(chart, 'the chart');
});

const catalogue = (imageTag: string, at: string, processes: Processes, imageDigest?: string) => new ReleaseCatalogue(db.instances, { dataVersion: async () => 0,
  repoRoot: repo,
  chartsDir,
  imageTag,
  imageDigest,
  processes,
  chart: async () => chart,
  inventory: async (release, out) => {
    inventoried.push({ release, out });
    writeFileSync(out, JSON.stringify({ bomFormat: 'CycloneDX', metadata: { component: { version: release } } }));
  },
}, () => new Date(at));

const chartSha256 = createHash('sha256').update('the chart').digest('hex');
const ONE = 'aaaaaaaaaaaa';
const TWO = 'bbbbbbbbbbbb';
const THREE = 'cccccccccccc';

describe('the releases root has run', () => {
  it('records a tagged release with its notes, keeps when it was first served, and keeps its chart', async () => {
    const hotfix = `v2026.10.25\n\nHotfix released from ${ONE} after v2026.10.24 without the gates: typecheck and the image build.`;
    const git = checkout(ONE, { name: 'v2026.10.25', message: hotfix });
    expect(await catalogue(ONE, '2026-10-25T00:00:00.000Z', git).recordCurrent()).toEqual({
      imageTag: ONE, version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', hotfix: true,
      notes: `Hotfix released from ${ONE} after v2026.10.24 without the gates: typecheck and the image build.`, chartSha256,
    });
    const again = catalogue(ONE, '2026-10-27T00:00:00.000Z', git);
    expect((await again.recordCurrent()).servedAt).toBe('2026-10-25T00:00:00.000Z');
    expect(readFileSync(again.chartFile(ONE)!, 'utf8')).toBe('the chart');
    expect(again.hasChart(ONE)).toBe(true);
    expect(again.hasChart(TWO)).toBe(false);
    expect(again.chartFile('../../etc/passwd')).toBeUndefined();
    expect(inventoried.map((entry) => entry.release)).toEqual(['v2026.10.25', 'v2026.10.25']);
    expect(JSON.parse(readFileSync(again.inventoryFile(ONE)!, 'utf8'))).toMatchObject({ metadata: { component: { version: 'v2026.10.25' } } });
    expect(again.inventoryFile(TWO)).toBeUndefined();
    expect(again.inventoryFile('../../etc/passwd')).toBeUndefined();
  });

  it('records the release even when its inventory cannot be written, so instances are still offered it', async () => {
    const failing = new ReleaseCatalogue(db.instances, { repoRoot: repo, dataVersion: async () => 0, chartsDir, imageTag: ONE, processes: checkout(ONE), chart: async () => chart, inventory: async () => { throw new Error('dependencies.pins.json is missing'); } }, () => new Date('2026-10-30T00:00:00.000Z'));
    expect((await failing.recordCurrent()).imageTag).toBe(ONE);
    expect((await failing.releases()).map((release) => release.imageTag)).toContain(ONE);
    expect(failing.inventoryFile(ONE)).toBeUndefined();
  });

  it('records a build no tag names under its image tag, and lists every release', async () => {
    await catalogue(ONE, '2026-10-25T00:00:00.000Z', checkout(ONE)).recordCurrent();
    const now = catalogue(TWO, '2026-10-26T00:00:00.000Z', checkout(TWO, { name: 'v2026.10.26', message: `v2026.10.26\n\nShipped and released from ${TWO} after v2026.10.25: release-live.` }));
    await now.recordCurrent();
    expect((await now.releases()).map((release) => [release.imageTag, release.version, release.hotfix ?? false])).toEqual([
      [ONE, ONE, false],
      [TWO, 'v2026.10.26', false],
    ]);
    expect(existsSync(join(chartsDir, `${TWO}.tgz`))).toBe(true);
  });

  it('names an image built from another commit by its image tag, and vouches for no digest, whatever the checkout carries', async () => {
    const git = checkout(ONE, { name: 'v2026.10.26', message: `v2026.10.26\n\nShipped and released from ${ONE} after v2026.10.25: release-live.` });
    const elsewhere = catalogue('nothing-here', '2026-10-26T00:00:00.000Z', git, `sha256:${'c'.repeat(64)}`);
    expect(await elsewhere.recordCurrent()).toEqual(expect.objectContaining({ imageTag: 'nothing-here', version: 'nothing-here' }));
    expect((await elsewhere.releases())[0]?.digest).toBeUndefined();
  });

  it('names a build by its image tag when git cannot be asked at all', async () => {
    const git = mock<Processes>();
    git.run.mockRejectedValue(new Error('git is not installed'));
    expect(await catalogue(ONE, '2026-10-26T00:00:00.000Z', git).recordCurrent()).toMatchObject({ imageTag: ONE, version: ONE });
  });

  it('keeps the digest the image was released under and the chart\'s sha256, and answers only once they are recorded', async () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const now = catalogue(ONE, '2026-10-25T00:00:00.000Z', checkout(ONE), digest);
    void now.recordCurrent();
    expect(await now.releases()).toEqual([expect.objectContaining({ imageTag: ONE, digest, chartSha256 })]);
    const unpinned = catalogue(ONE, '2026-10-26T00:00:00.000Z', checkout(ONE), 'latest');
    await unpinned.recordCurrent();
    expect((await unpinned.releases())[0]?.digest).toBeUndefined();
  });

  it('withdraws every release newer than the one root boots onto, and clears it when root moves onto one again', async () => {
    await catalogue(ONE, '2026-10-25T00:00:00.000Z', checkout(ONE)).recordCurrent();
    await catalogue(TWO, '2026-10-26T00:00:00.000Z', checkout(TWO)).recordCurrent();
    await catalogue(THREE, '2026-10-27T00:00:00.000Z', checkout(THREE)).recordCurrent();

    const back = await catalogue(ONE, '2026-10-28T00:00:00.000Z', checkout(ONE)).recordCurrent();
    expect(back.withdrawn).toBeUndefined();
    const withdrawn = Object.fromEntries((await db.instances.getReleases()).map((release) => [release.imageTag, release.withdrawn]));
    expect(withdrawn).toEqual({ [ONE]: undefined, [TWO]: { at: '2026-10-28T00:00:00.000Z', by: `root rolled back to ${ONE}` }, [THREE]: { at: '2026-10-28T00:00:00.000Z', by: `root rolled back to ${ONE}` } });

    await catalogue(ONE, '2026-10-29T00:00:00.000Z', checkout(ONE)).recordCurrent();
    expect((await db.instances.getReleases()).find((release) => release.imageTag === TWO)?.withdrawn?.at).toBe('2026-10-28T00:00:00.000Z');

    const forward = await catalogue(TWO, '2026-10-30T00:00:00.000Z', checkout(TWO)).recordCurrent();
    expect(forward.withdrawn).toBeUndefined();
    const after = Object.fromEntries((await db.instances.getReleases()).map((release) => [release.imageTag, release.withdrawn?.by]));
    expect(after).toEqual({ [ONE]: undefined, [TWO]: undefined, [THREE]: `root rolled back to ${ONE}` });
  });
});

describe('the releases root has run, on the real clock', () => {
  it('stamps a release with the moment it was first served when it is given no clock', async () => {
    const before = Date.now();
    const recorded = await new ReleaseCatalogue(db.instances, { repoRoot: repo, dataVersion: async () => 0, chartsDir, imageTag: ONE, processes: checkout(ONE), chart: async () => chart, inventory: async () => undefined }).recordCurrent();
    expect(Date.parse(recorded.servedAt ?? '')).toBeGreaterThanOrEqual(before);
  });
});
