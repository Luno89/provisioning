import { describe, it, expect, beforeEach } from 'vitest';
import { frontierRow, keywordScore, frontierOrder, followsLinks } from './frontier.js';
import { MemoryDB } from './memory-db.js';

describe('queueing a URL', () => {
  it('derives the id from the ingest and the URL, so a duplicate cannot be stored', () => {
    // This is the whole deduplication mechanism. It used to be a Set held in the workflow, which
    // meant `seen` was replayed from event history on every batch.
    const a = frontierRow('i1', 'https://a.example/x', 0, []);
    const b = frontierRow('i1', 'https://a.example/x', 3, ['other']);
    expect(a.id).toBe(b.id);
  });

  it('scores the URL once, at enqueue', () => {
    // An index cannot sort by a function, so the ordering has to be a stored number.
    expect(keywordScore('https://a.example/licence-and-pricing', ['pricing', 'licence'])).toBe(2);
    expect(keywordScore('https://a.example/BLOG', ['blog'])).toBe(1);
    expect(keywordScore('https://a.example/blog', [])).toBe(0);
  });
});

describe('the order pages come out in', () => {
  const row = (url: string, depth: number, rank: number) => ({ ...frontierRow('i1', url, depth, []), rank });

  it('is shallow first, then keyword score', () => {
    const rows = [row('https://a/deep', 2, 5), row('https://a/shallow', 0, 0), row('https://a/mid', 1, 9)];
    expect(rows.sort(frontierOrder).map((r) => r.url)).toEqual(['https://a/shallow', 'https://a/mid', 'https://a/deep']);
  });

  it('breaks a tie on the URL, so a retried batch is the same batch', () => {
    /**
     * Not cosmetic. `claimFrontier` does not mutate, so an activity Temporal retries re-reads the
     * frontier — and if two equal-ranked pages could come back in either order, the retry would
     * fetch one and silently drop the other.
     */
    const rows = [row('https://a/z', 1, 1), row('https://a/a', 1, 1)];
    expect(rows.sort(frontierOrder).map((r) => r.url)).toEqual(['https://a/a', 'https://a/z']);
    expect([...rows].reverse().sort(frontierOrder).map((r) => r.url)).toEqual(['https://a/a', 'https://a/z']);
  });
});

describe('spending the depth budget', () => {
  it('stops collecting links at the last permitted depth', () => {
    // Otherwise the final level queues thousands of pages the crawl will never fetch.
    expect(followsLinks(0, 1)).toBe(true);
    expect(followsLinks(1, 1)).toBe(false);
    expect(followsLinks(0, 0)).toBe(false);
  });
});

describe('the frontier as a queue', () => {
  let db: MemoryDB;
  beforeEach(async () => { db = new MemoryDB(); await db.init(); });

  it('counts only what was genuinely new', async () => {
    // Every page in a crawl is linked from somewhere, so re-offering is the common path.
    const first = await db.enqueueFrontier([frontierRow('i1', 'https://a/x', 0, [])]);
    const again = await db.enqueueFrontier([
      frontierRow('i1', 'https://a/x', 1, []),
      frontierRow('i1', 'https://a/y', 1, []),
    ]);
    expect(first).toBe(1);
    expect(again).toBe(1);
    expect(await db.countFrontier('i1')).toBe(2);
  });

  it('hands out the same batch twice, because claiming does not mutate', async () => {
    await db.enqueueFrontier([frontierRow('i1', 'https://a/x', 0, []), frontierRow('i1', 'https://a/y', 0, [])]);
    const once = await db.claimFrontier('i1', 1);
    expect(await db.claimFrontier('i1', 1)).toEqual(once);
  });

  it('only drops a page from the queue once it is stored', async () => {
    await db.enqueueFrontier([frontierRow('i1', 'https://a/x', 0, [])]);
    await db.completeFrontier('i1', ['https://a/x']);
    expect(await db.claimFrontier('i1', 8)).toEqual([]);
    expect(await db.countFrontier('i1')).toBe(0);
  });

  it('keeps one ingest out of another\'s queue', async () => {
    await db.enqueueFrontier([frontierRow('i1', 'https://a/x', 0, []), frontierRow('i2', 'https://a/x', 0, [])]);
    expect(await db.countFrontier('i1')).toBe(1);
    await db.deleteFrontier('i1');
    expect(await db.countFrontier('i2')).toBe(1);
  });
});
