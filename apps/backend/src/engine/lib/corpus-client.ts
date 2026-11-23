import { collectionConfig } from './corpus-backend.js';
import type { MemoryIndexReach, Reaching } from '../../platform/index.js';
import { answered, refusal } from './corpus-stores.js';

const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === 'number');

const made = new Set<string>();

async function madeOnce(reach: Reaching & { base: string }, what: string, who: string, make: () => Promise<Response>): Promise<void> {
  const key = `${reach.base} ${what}`;
  if (made.has(key)) return;
  const res = await make();
  if (res.ok) { made.add(key); return; }
  const body = await res.text();
  if (/already exist/i.test(body)) { made.add(key); return; }
  throw reach.failed(refusal(who, res, body));
}

export const ensureIndex = (index: MemoryIndexReach['index'], id: string, config: unknown): Promise<void> =>
  madeOnce(index, `index ${id}`, 'Quickwit', () => index.fetch(`${index.base}/api/v1/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }));

export const ensureCollection = (vectors: MemoryIndexReach['vectors'], name: string): Promise<void> =>
  madeOnce(vectors, `collection ${name}`, 'Qdrant', () => vectors.fetch(`${vectors.base}/collections/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'api-key': vectors.apiKey },
    body: JSON.stringify(collectionConfig()),
  }));

export const EMBED_BATCH = 32;

export async function embed(embeddings: MemoryIndexReach['embeddings'], inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];

  const out: number[][] = [];
  for (let at = 0; at < inputs.length; at += EMBED_BATCH) {
    const res = await embeddings.fetch(`${embeddings.base}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: inputs.slice(at, at + EMBED_BATCH), truncate: true }),
    });
    const body = await answered(res, 'TEI', embeddings);
    if (!Array.isArray(body)) continue;
    if (!body.every(isVector)) throw new Error('The embedding service answered with something that is not a list of vectors');
    out.push(...body);
  }
  return out;
}
