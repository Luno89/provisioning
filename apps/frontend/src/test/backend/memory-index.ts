import { afterAll } from 'vitest'
import { unindexerFrom, type MemoryUnindexer } from '../../../../backend/src/memory/lib/memory-index'
import { startCorpusStandIn } from '../../../../backend/src/engine/testing/corpus-stand-in'

export function standInMemoryIndex(): MemoryUnindexer {
  const started = startCorpusStandIn()
  afterAll(async () => { await (await started).stop() })
  return async (ownerId, ids) => unindexerFrom((await started).endpoints)(ownerId, ids)
}
