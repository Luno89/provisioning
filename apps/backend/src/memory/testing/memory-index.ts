import { afterAll } from 'vitest';
import { startCorpusStandIn } from '../../engine/testing/corpus-stand-in.js';
import { unindexerFrom, type MemoryUnindexer } from '../lib/memory-index.js';

export async function standInUnindexer(): Promise<MemoryUnindexer> {
  const standIn = await startCorpusStandIn();
  afterAll(async () => { await standIn.stop(); });
  return unindexerFrom(standIn.reach);
}
