import { afterAll } from 'vitest';
import { startCorpusStandIn } from '../../engine/testing/corpus-stand-in.js';
import { indexingFrom, type MemoryIndexing, type MemoryUnindexer } from '../lib/memory-index.js';

export async function standInIndexing(): Promise<MemoryIndexing> {
  const standIn = await startCorpusStandIn();
  afterAll(async () => { await standIn.stop(); });
  return indexingFrom(standIn.reach);
}

export async function standInUnindexer(): Promise<MemoryUnindexer> {
  return (await standInIndexing()).unindex;
}
