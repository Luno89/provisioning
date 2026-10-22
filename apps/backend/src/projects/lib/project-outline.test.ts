import { describe, it, expect } from 'vitest';
import { projectOutline, type StatusRelease, type StatusRun } from './project-outline.js';

const shop = { id: 'p1', name: 'Shop' };
const release = (commit: string, state: StatusRelease['state'], startedAt: string, extra: Partial<StatusRelease> = {}): StatusRelease => ({ commit, state, startedAt, updatedAt: startedAt, ...extra });
const run = (commitSha: string, status: StatusRun['status'], startedAt: string, extra: Partial<StatusRun> = {}): StatusRun => ({ commitSha, status, startedAt, ...extra });

describe('a project\'s status as Koala is handed it', () => {
  it('says nothing is live and nothing has built for a new project', () => {
    expect(projectOutline(shop, [], [])).toBe([
      'Project "Shop" (p1).',
      'Live: nothing yet.',
      'Last build: none yet.',
      'Earlier releases: project_releases.',
    ].join('\n'));
  });

  it('names the newest live release, a preview the person decides on, one in progress, and the last build with why it was not released', () => {
    const text = projectOutline(shop, [
      release('old0000000', 'superseded', '2026-10-01T00:00:00Z'),
      release('live000000', 'live', '2026-10-02T00:00:00Z', { slot: 'a', liveAt: '2026-10-02T01:30:00Z' }),
      release('prev000000', 'preview', '2026-10-03T00:00:00Z', { slot: 'b' }),
      release('next000000', 'cutting-over', '2026-10-04T00:00:00Z', { slot: 'b' }),
    ], [
      run('live000000', 'succeeded', '2026-10-02T00:00:00Z'),
      run('docs000000', 'succeeded', '2026-10-05T00:00:00Z', { finishedAt: '2026-10-05T00:04:00Z', releaseSkipped: 'only docs changed' }),
    ]);
    expect(text.split('\n')).toEqual([
      'Project "Shop" (p1).',
      'Live: live0000 in slot a, since 2026-10-02 01:30 UTC.',
      'Waiting for the person: prev0000 is ready to preview in slot b. Cutting over or discarding it is theirs, on the project\'s board; tell them it is there rather than doing it.',
      'In progress: next0000 is cutting-over.',
      'Last build: succeeded, docs0000, 2026-10-05 00:04 UTC; not released: only docs changed.',
      'Earlier releases: project_releases.',
    ]);
  });

  it('takes the promoted build as live for a project deployed by image, and says why the last build failed', () => {
    const text = projectOutline(shop, [], [
      run('img0000000', 'succeeded', '2026-10-02T00:00:00Z', { promotedAt: '2026-10-02T00:10:00Z' }),
      run('bad0000000', 'failed', '2026-10-03T00:00:00Z', { errorMessage: 'npm ci failed' }),
    ]);
    expect(text).toContain('Live: img00000, deployed 2026-10-02 00:10 UTC.');
    expect(text).toContain('Last build: failed, bad00000, 2026-10-03 00:00 UTC: npm ci failed.');
  });
});
