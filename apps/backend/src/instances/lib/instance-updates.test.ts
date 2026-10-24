import { describe, expect, it } from 'vitest';
import { choosable, pickProblem, releaseFromTag, updateTarget, updatesView, type InstanceRelease } from './instance-updates.js';

const releases: InstanceRelease[] = [
  { imageTag: 'c3', version: 'v2026.10.26', servedAt: '2026-10-26T00:00:00.000Z' },
  { imageTag: 'a1', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
  { imageTag: 'b2', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', hotfix: true },
];

describe('the release an instance is told to run', () => {
  it('on auto, follows root forward and never back', () => {
    expect(updateTarget({ auto: true }, 'a1', 'c3', releases)).toBe('c3');
    expect(updateTarget({ auto: true }, 'c3', 'b2', releases)).toBe('c3');
    expect(updateTarget({ auto: true }, undefined, 'b2', releases)).toBe('b2');
  });

  it('off auto, runs what the person picked, otherwise stays where it is', () => {
    expect(updateTarget({ auto: false, picked: 'b2' }, 'a1', 'c3', releases)).toBe('b2');
    expect(updateTarget({ auto: false }, 'a1', 'c3', releases)).toBe('a1');
  });
});

describe('what a person may pick', () => {
  it('any newer release, and the one it ran just before', () => {
    expect(choosable(releases, 'b2', 'a1')).toEqual(['c3', 'a1']);
    expect(choosable(releases, 'c3', 'b2')).toEqual(['b2']);
    expect(choosable(releases, 'c3', undefined)).toEqual([]);
  });

  it('every release when root never served the one it runs', () => {
    expect(choosable(releases, 'dev', undefined)).toEqual(['a1', 'b2', 'c3']);
  });

  it('refuses an older one with the way back named, and one that does not exist', () => {
    expect(pickProblem(releases, 'c3', 'b2', 'v2026.10.25')).toBeUndefined();
    expect(pickProblem(releases, 'c3', 'b2', 'v2026.10.24')).toBe('v2026.10.24 is older than what this instance runs; it can move to a newer release, or back to v2026.10.25, the one it ran before');
    expect(pickProblem(releases, 'c3', undefined, 'v2026.10.24')).toBe('v2026.10.24 is older than what this instance runs; it can move to a newer release');
    expect(pickProblem(releases, 'a1', undefined, 'v2027.01.01')).toBe('there is no release v2027.01.01');
    expect(pickProblem(releases, 'a1', undefined, 'c3')).toBeUndefined();
  });
});

describe('a release as root records it', () => {
  it('reads its version, notes and whether it was a hotfix from its tag', () => {
    expect(releaseFromTag('b2', 'v2026.10.25', 'v2026.10.25\n\nHotfix released from b2b2b2b2b2b2 after v2026.10.24 without the gates: typecheck and the image build.', 'then'))
      .toEqual({ imageTag: 'b2', version: 'v2026.10.25', servedAt: 'then', notes: 'Hotfix released from b2b2b2b2b2b2 after v2026.10.24 without the gates: typecheck and the image build.', hotfix: true });
    expect(releaseFromTag('a1', 'v2026.10.24', 'v2026.10.24\n\nShipped and released from a1a1a1a1a1a1 after v2026.10.23: mail-live.', 'then').hotfix).toBeUndefined();
    expect(releaseFromTag('d4d4d4d4d4d4', undefined, undefined, 'then')).toEqual({ imageTag: 'd4d4d4d4d4d4', version: 'd4d4d4d4d4d4', servedAt: 'then' });
  });
});

describe('the updates page', () => {
  it('lists releases newest first, marking what runs, what root runs and what may be picked', () => {
    const view = updatesView({ auto: false }, 'b2', 'a1', 'c3', releases);
    expect(view.target).toBe('b2');
    expect(view.releases.map((row) => [row.version, row.running, row.current, row.choosable])).toEqual([
      ['v2026.10.26', false, true, true],
      ['v2026.10.25', true, false, false],
      ['v2026.10.24', false, false, true],
    ]);
  });
});
