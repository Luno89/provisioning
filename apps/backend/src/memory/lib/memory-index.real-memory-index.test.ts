import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unreportedReach } from '../../platform/testing/memory-index.js';
import { dnsMemory } from '../testing/memories.js';
import { bytesOf, pinnedContainer, startMemoryIndex, type RealMemoryIndex } from '../testing/real-memory-index.js';
import { indexMemories, searchMemories } from './memory-index.js';

let real: RealMemoryIndex;
beforeAll(async () => { real = await startMemoryIndex(); });
afterAll(async () => { await real.stop(); });

const bank = [
  dnsMemory({ id: 'dns', title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain at Cloudflare.' }),
  dnsMemory({ id: 'gpu', title: 'Builds run on the GPU box', text: 'Every build runs on the machine with two 3090s in the hall.' }),
  dnsMemory({ id: 'mail', title: 'Mail goes through root', text: 'An instance sends its mail through root, only to its owner.' }),
  dnsMemory({ id: 'labels', title: 'Labels print on A6', text: 'The courier only accepts delivery labels printed on A6 paper.' }),
  dnsMemory({ id: 'style', title: 'Short answers', text: 'The person wants answers in short sentences, without headings.' }),
  dnsMemory({ id: 'theirs', ownerId: 'someone-else', title: 'Their DNS', text: 'Their domain\'s nameservers are at Porkbun.' }),
];

describe('the memory index, Quickwit, Qdrant and TEI at their pinned versions', () => {
  it('finds a handful of memories by what they mean, and only the person\'s own', async () => {
    const reach = unreportedReach(real.index);
    expect(await indexMemories(reach, bank)).toEqual({ vectors: 6, documents: 6 });

    expect((await searchMemories(reach, 'which company hosts my nameservers?', { ownerId: 'u1' }))[0]?.id).toBe('dns');
    expect((await searchMemories(reach, 'what paper size for shipping stickers', { ownerId: 'u1' }))[0]?.id).toBe('labels');
    expect((await searchMemories(reach, 'where are graphics cards for compiling', { ownerId: 'u1' }))[0]?.id).toBe('gpu');
    expect((await searchMemories(reach, 'nameservers', { ownerId: 'u1' })).map((hit) => hit.id)).not.toContain('theirs');
  });

  it('fits each piece in the memory the chart gives it, with that workload done', async () => {
    for (const piece of ['quickwit', 'qdrant', 'tei'] as const) {
      const used = await real.memoryInUse(real.containers[piece]);
      expect(used, `${piece} uses ${Math.round(used / 1024 ** 2)} MiB`).toBeLessThan(bytesOf(pinnedContainer(piece).memoryLimit));
    }
  });
});
