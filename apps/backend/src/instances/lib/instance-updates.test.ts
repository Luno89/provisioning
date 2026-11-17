import { describe, expect, it } from 'vitest';
import { choosable, dataHeldMail, dataHolds, isWithdrawn, pickProblem, releaseFromTag, rolledBackTo, updateTarget, updatesView, withdrawnBy, type InstanceRelease } from './instance-updates.js';

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

describe('a release root rolled back from', () => {
  const pulled = { at: '2026-10-27T00:00:00.000Z', by: rolledBackTo('v2026.10.25') };
  const afterRollback: InstanceRelease[] = releases.map((release) => (release.imageTag === 'c3' ? { ...release, withdrawn: pulled } : release));

  it('is every release newer than root\'s own, and root moving onto one again clears it', () => {
    expect(withdrawnBy(releases, 'b2')).toEqual({ clear: false, withdraw: ['c3'] });
    expect(withdrawnBy(releases, 'c3')).toEqual({ clear: false, withdraw: [] });
    expect(withdrawnBy(afterRollback, 'b2')).toEqual({ clear: false, withdraw: [] });
    expect(withdrawnBy(afterRollback, 'c3')).toEqual({ clear: true, withdraw: [] });
    expect(withdrawnBy(releases, 'zz')).toEqual({ clear: false, withdraw: [] });
    expect(isWithdrawn(afterRollback, 'c3')).toBe(true);
    expect(isWithdrawn(afterRollback, 'b2')).toBe(false);
  });

  it('is never offered: an instance on auto that runs it follows root down, even with what root recorded it running gone stale', () => {
    expect(updateTarget({ auto: true }, 'c3', 'b2', afterRollback)).toBe('b2');
    expect(updateTarget({ auto: true }, 'a1', 'b2', afterRollback)).toBe('b2');
    expect(updateTarget({ auto: true }, 'b2', 'b2', afterRollback)).toBe('b2');
  });

  it('stays with an instance that picked it, which is shown as withdrawn and offered root\'s release', () => {
    expect(updateTarget({ auto: false, picked: 'c3' }, 'c3', 'b2', afterRollback)).toBe('c3');
    const view = updatesView({ auto: false, picked: 'c3' }, 'c3', 'b2', 'b2', afterRollback);
    expect(view.runningWithdrawn).toEqual(pulled);
    expect(view.releases.find((row) => row.imageTag === 'c3')?.withdrawn).toEqual(pulled);
    expect(view.releases.find((row) => row.imageTag === 'b2')?.choosable).toBe(true);
    expect(updatesView({ auto: true }, 'b2', undefined, 'b2', afterRollback).runningWithdrawn).toBeUndefined();
  });

  it('cannot be picked, newer or as the one run before', () => {
    expect(pickProblem(afterRollback, 'a1', undefined, 'v2026.10.26')).toBe(`v2026.10.26 was withdrawn when ${pulled.by}; pick another release`);
    expect(choosable(afterRollback, 'a1', undefined)).toEqual(['b2']);
    expect(choosable(afterRollback, 'b2', 'c3')).toEqual([]);
  });
});

describe('an instance whose data a release moved forward for good', () => {
  const moved: InstanceRelease[] = [
    { imageTag: 'old', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00.000Z' },
    { imageTag: 'new', version: 'v2026.11.17', servedAt: '2026-11-17T00:00:00.000Z', dataVersion: 1, withdrawn: { at: '2026-11-18T00:00:00.000Z', by: rolledBackTo('v2026.10.30') } },
  ];

  it('stays where it is when root rolls back below its data, on auto or on a pick, rather than run code that cannot read it', () => {
    expect(updateTarget({ auto: true }, 'new', 'old', moved, 1)).toBe('new');
    expect(updateTarget({ auto: false, picked: 'old' }, 'new', 'old', moved, 1)).toBe('new');
    expect(updateTarget({ auto: true }, 'new', 'old', moved, 0)).toBe('old');
  });

  it('offers no release below its data, and refuses a pick of one saying why', () => {
    expect(choosable(moved, 'new', 'old', 1)).toEqual([]);
    expect(pickProblem(moved, 'new', 'old', 'v2026.10.30', 1)).toBe('v2026.10.30 cannot run this instance\'s data: a later release moved it forward for good (data version 1), and v2026.10.30 knows only data version 0');
  });

  it('says on its updates page what holds it, and is told once by email', () => {
    expect(updatesView({ auto: true }, 'new', 'old', 'old', moved, 1)).toMatchObject({ target: 'new', heldByData: { version: 'v2026.10.30', needs: 1 } });
    const instances = [{ id: 'i1', ownerId: 'o1', name: 'luno', running: 'new', dataVersion: 1 }, { id: 'i2', ownerId: 'o2', running: 'old' }];
    const holds = dataHolds(instances, moved, 'old');
    expect(holds).toEqual([{ instanceId: 'i1', ownerId: 'o1', name: 'luno', release: moved[0], needs: 1, key: 'i1|old|1' }]);
    expect(dataHeldMail(holds[0]!)).toEqual({
      subject: 'luno stays on its release',
      text: 'Your instance luno stays on the release it runs: root now offers v2026.10.30, which cannot run its data, since a later release moved it forward for good (data version 1). It moves again once root offers a release that can.',
    });
  });
});
