import { afterAll } from 'vitest'
import { indexerFrom, unindexerFrom, type MemoryIndexing } from '../../../../backend/src/memory/lib/memory-index'
import { startCorpusStandIn } from '../../../../backend/src/engine/testing/corpus-stand-in'

export function standInMemoryIndex(): MemoryIndexing {
  const started = startCorpusStandIn()
  afterAll(async () => { await (await started).stop() })
  return {
    index: async (items) => indexerFrom((await started).reach)(items),
    unindex: async (ownerId, ids) => unindexerFrom((await started).reach)(ownerId, ids),
  }
}
