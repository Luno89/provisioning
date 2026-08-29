import { describe, it, expect } from 'vitest';
import { APP_TYPES, APP_FACTS, providing } from './app-catalog.js';

describe('every type is described', () => {
  it('leaves none undescribed, so adding one cannot skip this', () => {
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
    const media = providing('media');
    expect(media.length).toBeGreaterThan(1);
    expect(media).toContain('jellyfin');
  });

  it('is empty for something this platform does not provide', () => {
    expect(providing('relational-database')).toEqual([]);
    expect(providing('document-database')).toEqual([]);
  });

  it('does not match loosely', () => {
    expect(providing('storage')).toEqual([]);
    expect(providing('search')).toEqual([]);
  });
});
