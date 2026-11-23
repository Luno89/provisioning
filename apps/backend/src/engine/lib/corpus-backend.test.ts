import { describe, it, expect, vi } from 'vitest';
import { pointId, collectionConfig, VECTOR_SIZE } from './corpus-backend.js';
import { embed, EMBED_BATCH } from './corpus-client.js';
import { unreportedReach } from '../../platform/testing/memory-index.js';

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

    const vectors = await embed(unreportedReach({ index: { base: 'http://quickwit' }, vectors: { base: 'http://qdrant', apiKey: 'k' }, embeddings: { base: 'http://tei' } }).embeddings, Array.from({ length: 100 }, (_, i) => `chunk ${i}`));
    expect(Math.max(...seen)).toBeLessThanOrEqual(EMBED_BATCH);
    expect(vectors).toHaveLength(100);
    vi.unstubAllGlobals();
  });
});
