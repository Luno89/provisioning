import { arrayWith, objectWith } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, vi } from 'vitest';
import {
  chunkText, chunksFor, pointId, indexConfig, collectionConfig, worthEmbedding,
  CHUNK_CHARS, CHUNK_OVERLAP, VECTOR_SIZE,
} from './corpus-backend.js';
import { embed, EMBED_BATCH } from './corpus-client.js';

describe('splitting a page for embedding', () => {
  it('leaves a short page as one chunk', () => {
    expect(chunkText('a short page')).toEqual(['a short page']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('overlaps, so a sentence across a boundary is in something', () => {
    const text = 'x'.repeat(CHUNK_CHARS * 2);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    const stride = CHUNK_CHARS - CHUNK_OVERLAP;
    expect(chunks[1]).toBe(text.slice(stride, stride + CHUNK_CHARS));
  });

  it('drops a trailing sliver already contained in the previous chunk', () => {
    const text = 'y'.repeat(CHUNK_CHARS + 20);
    const chunks = chunkText(text);
    expect(chunks.every((c) => c.length > CHUNK_OVERLAP)).toBe(true);
  });

  it('numbers chunks so re-ingesting replaces rather than duplicates', () => {
    const a = chunksFor('https://x/p', 'z'.repeat(CHUNK_CHARS * 2));
    const b = chunksFor('https://x/p', 'z'.repeat(CHUNK_CHARS * 2));
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a[0]!.id).toBe('https://x/p#0');
  });

  it('numbers by position in the page, so filtering does not renumber what is left', () => {
    const nav = '[a](https://x) '.repeat(60);
    const prose = 'This is a real paragraph of documentation prose. '.repeat(20);
    const ids = chunksFor('https://x/p', nav + prose).map((c) => c.id);
    expect(ids[0]).not.toBe('https://x/p#0');
  });
});

describe('point ids', () => {
  it('is a uuid, because Qdrant rejects anything else', () => {
    expect(pointId('https://x/p#3')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is stable and distinct', () => {
    expect(pointId('https://x/p#0')).toBe(pointId('https://x/p#0'));
    expect(pointId('https://x/p#0')).not.toBe(pointId('https://x/p#1'));
    expect(pointId('https://x/p#0')).not.toBe(pointId('https://y/p#0'));
  });
});

describe('the service configuration', () => {
  it('matches the vector size the embedding model emits', () => {
    expect(collectionConfig()).toMatchObject({ vectors: { size: VECTOR_SIZE } });
  });

  it('keeps quantized vectors in RAM and the originals on disk', () => {
    expect(collectionConfig()).toMatchObject({ vectors: { on_disk: true }, quantization_config: { scalar: { type: 'int8', always_ram: true } } });
  });

  it('indexes ids as whole terms, not as tokens', () => {
    for (const name of ['owner_id', 'ingest_id', 'url']) {
      expect(indexConfig('koala-corpus')).toMatchObject({ doc_mapping: { field_mappings: arrayWith([objectWith({ name, tokenizer: 'raw' })]) } });
    }
  });

  it('records positions, so a quoted phrase is a phrase', () => {
    expect(indexConfig('koala-corpus')).toMatchObject({ doc_mapping: { field_mappings: arrayWith([objectWith({ name: 'body', record: 'position' })]) } });
  });
});

describe('batching the embedding requests', () => {
  it('never sends more than the service accepts', async () => {
    const seen: number[] = [];
    const fake = vi.fn<typeof fetch>(async (_url, init) => {
      const { inputs } = JSON.parse(String(init?.body)) as { inputs: string[] };
      seen.push(inputs.length);
      return new Response(JSON.stringify(inputs.map(() => [0.1, 0.2])), { status: 200 });
    });
    vi.stubGlobal('fetch', fake);

    const vectors = await embed('http://tei', Array.from({ length: 100 }, (_, i) => `chunk ${i}`));
    expect(Math.max(...seen)).toBeLessThanOrEqual(EMBED_BATCH);
    expect(vectors).toHaveLength(100);
    vi.unstubAllGlobals();
  });
});

describe('deciding what is worth a vector', () => {
  it('drops a navigation menu', () => {
    const nav = '[Skip to main content](https://docs.github.com/x) [GitHub Docs](https://docs.github.com) '.repeat(6);
    expect(worthEmbedding(nav)).toBe(false);
  });

  it('keeps prose that happens to contain a link', () => {
    const prose = 'The primary rate limit for unauthenticated requests is 60 requests per hour, as '
      + 'described in [the documentation](https://docs.github.com/x). Exceeding it returns a 403 '
      + 'with a Retry-After header that the client is expected to honour before retrying.';
    expect(worthEmbedding(prose)).toBe(true);
  });

  it('drops a chunk with almost no text at all', () => {
    expect(worthEmbedding('   ')).toBe(false);
    expect(worthEmbedding('Search or ask Copilot')).toBe(false);
  });
});
