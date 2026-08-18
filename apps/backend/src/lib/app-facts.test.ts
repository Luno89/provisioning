import { describe, it, expect } from 'vitest';
import { APP_TYPES, APP_FACTS, providing } from './app-catalog.js';

/**
 * What each deployable app IS.
 *
 * ── WHY THIS IS NOT DECORATION ──
 * `APP_TYPES` is twenty-six bare ids. Asked to add MongoDB caching to an MCP server, Koala planned
 * it — there is no MongoDB here, and nothing in the catalogue would have said so. Worse, it could
 * not have found the alternative either: nothing said `qdrant` is a vector database or `minio` is
 * object storage, and `tei` and `quickwit` are unguessable from their names.
 */

describe('every type is described', () => {
  it('leaves none undescribed, so adding one cannot skip this', () => {
    // A Record<AppType, …> makes this a type error too; the test states the intent for a reader.
    for (const type of APP_TYPES) {
      expect(APP_FACTS[type]?.is, type).toBeTruthy();
      expect(APP_FACTS[type]?.provides.length, type).toBeGreaterThan(0);
    }
  });

  it('describes the three that are unguessable from their names', () => {
    expect(APP_FACTS.qdrant.is).toMatch(/vector database/);
    expect(APP_FACTS.tei.is).toMatch(/embedding/);
    expect(APP_FACTS.quickwit.is).toMatch(/full-text search/);
  });
});

describe('finding a service by what it does', () => {
  it('answers "where do I put blobs"', () => {
    expect(providing('object-storage')).toContain('minio');
  });

  it('returns every app offering a capability, not just the first', () => {
    // Several media servers provide the same thing, and a plan should see the choice.
    const media = providing('media');
    expect(media.length).toBeGreaterThan(1);
    expect(media).toContain('jellyfin');
  });

  it('is empty for something this platform does not provide', () => {
    /**
     * The load-bearing answer, and the one that was missing. An empty result means the request
     * cannot be satisfied here — which is what should be said, rather than designed around.
     */
    expect(providing('relational-database')).toEqual([]);
    expect(providing('document-database')).toEqual([]);
  });

  it('does not match loosely', () => {
    // A near-miss returning something plausible is worse than nothing: it would send a plan at a
    // service that cannot do the job.
    expect(providing('storage')).toEqual([]);
    expect(providing('search')).toEqual([]);
  });
});
