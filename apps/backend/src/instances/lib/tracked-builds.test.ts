import { describe, expect, it } from 'vitest';
import { trackedBuilds, trackedImageOf } from './tracked-builds.js';

const pinned = 'a'.repeat(64);
const newer = 'b'.repeat(64);

describe('a floating tag followed by its digest', () => {
  it('reads the registry, repository and pinned digest from the pin\'s source', () => {
    expect(trackedImageOf({ name: 'theroyallab/tabbyapi', source: `ghcr.io/theroyallab/tabbyapi@sha256:${pinned}`, tracks: 'latest' })).toEqual({ image: 'theroyallab/tabbyapi', host: 'ghcr.io', repository: 'theroyallab/tabbyapi', tag: 'latest', pinned });
    expect(trackedImageOf({ name: 'theroyallab/tabbyapi', source: `ghcr.io/theroyallab/tabbyapi@sha256:${pinned}` })).toBeUndefined();
    expect(trackedImageOf({ name: 'x', source: 'ghcr.io/x:latest', tracks: 'latest' })).toBeUndefined();
  });

  it('lists a build other than the pinned one with when it was first seen, takeable two weeks after', () => {
    const seen = [{ image: 'theroyallab/tabbyapi', tag: 'latest', pinned, digest: newer, builtAt: '2026-11-12T20:00:00Z', revision: 'c0ffee' }];
    const first = trackedBuilds([], seen, new Date('2026-11-13T12:00:00Z'));
    expect(first).toEqual([{ ...seen[0], firstSeenAt: '2026-11-13T12:00:00.000Z', takeOn: '2026-11-27' }]);
    expect(trackedBuilds(first, seen, new Date('2026-11-20T12:00:00Z'))).toEqual(first);
  });

  it('lists nothing while the tag still names the pinned build', () => {
    expect(trackedBuilds([], [{ image: 'theroyallab/tabbyapi', tag: 'latest', pinned, digest: pinned }], new Date('2026-11-13T12:00:00Z'))).toEqual([]);
  });

  it('starts the two weeks again for a build the tag moved to after another', () => {
    const before = trackedBuilds([], [{ image: 'theroyallab/tabbyapi', tag: 'latest', pinned, digest: newer }], new Date('2026-11-13T12:00:00Z'));
    const later = 'c'.repeat(64);
    expect(trackedBuilds(before, [{ image: 'theroyallab/tabbyapi', tag: 'latest', pinned, digest: later }], new Date('2026-11-20T12:00:00Z'))).toEqual([
      { image: 'theroyallab/tabbyapi', tag: 'latest', pinned, digest: later, firstSeenAt: '2026-11-20T12:00:00.000Z', takeOn: '2026-12-04' },
    ]);
  });
});
