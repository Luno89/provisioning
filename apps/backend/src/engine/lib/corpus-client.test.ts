import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { qdrantAt, quickwitAt } from '../../platform/testing/memory-index.js';
import { ensureCollection, ensureIndex } from './corpus-client.js';

const INDEX = { index_id: 'koala-memory' };

const server = interceptHttp();

describe('making the memory index\'s index and collection', () => {
  it('an index Quickwit refuses to make fails with its answer, and is asked again next time', async () => {
    const base = 'http://quickwit-refusing.test:7280';
    let asked = 0;
    server.use(http.post(`${base}/api/v1/indexes`, () => { asked += 1; return HttpResponse.text('invalid index config', { status: 400 }); }));
    await expect(ensureIndex(quickwitAt(base), 'koala-memory', INDEX)).rejects.toThrow('Quickwit refused: HTTP 400 invalid index config');
    await expect(ensureIndex(quickwitAt(base), 'koala-memory', INDEX)).rejects.toThrow('Quickwit refused: HTTP 400 invalid index config');
    expect(asked).toBe(2);
  });

  it('an index that is already there is taken as made, and not asked for again', async () => {
    const base = 'http://quickwit-made.test:7280';
    let asked = 0;
    server.use(http.post(`${base}/api/v1/indexes`, () => { asked += 1; return HttpResponse.text('index `koala-memory` already exists', { status: 400 }); }));
    await ensureIndex(quickwitAt(base), 'koala-memory', INDEX);
    await ensureIndex(quickwitAt(base), 'koala-memory', INDEX);
    expect(asked).toBe(1);
  });

  it('a collection Qdrant refuses to make fails with its answer', async () => {
    const base = 'http://qdrant-refusing.test:6333';
    server.use(http.put(`${base}/collections/:collection`, () => HttpResponse.text('wrong api key', { status: 401 })));
    await expect(ensureCollection(qdrantAt(base), 'koala-memory')).rejects.toThrow('Qdrant refused: HTTP 401 wrong api key');
  });

  it('a collection that is already there is taken as made', async () => {
    const base = 'http://qdrant-made.test:6333';
    server.use(http.put(`${base}/collections/:collection`, () => HttpResponse.text('Collection `koala-memory` already exists!', { status: 409 })));
    await expect(ensureCollection(qdrantAt(base), 'koala-memory')).resolves.toBeUndefined();
  });
});
