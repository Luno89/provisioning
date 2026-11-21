import { vi } from 'vitest';
import type { Database } from '../../platform/index.js';
import type { MemoryIndexing, MemoryItem } from '../../memory/index.js';
import type { PoisoningSignal } from '../lib/poisoning.js';
import { PoisoningService } from '../services/PoisoningService.js';

export const POISONING_AT = '2026-10-29T10:00:00.000Z';

export const poisoningSignal = (over: Partial<PoisoningSignal>): PoisoningSignal => ({
  id: 's1', ownerId: 'owner', kind: 'private-out', severity: 'high', state: 'open', at: POISONING_AT, readsKey: 'grant-1', runId: 'run-1', tool: 'fetch_web_page',
  said: 'fetch_web_page sent out 40 characters this run read from file, to attacker.example', sealedMatch: 'sealed:the secret line', host: 'attacker.example', ...over,
});

export const poisoningMemory = (id: string, over: Partial<MemoryItem>): MemoryItem => ({
  id, ownerId: 'owner', category: 'lessons_learned', scope: 'global', status: 'active', title: id, text: id, createdAt: POISONING_AT, updatedAt: POISONING_AT, ...over,
});

export async function poisoningServiceOn(db: Pick<Database, 'engine' | 'memory'>, indexing: MemoryIndexing) {
  const push = vi.fn(async () => 1);
  const mail = vi.fn(async () => undefined);
  const poisoning = new PoisoningService({
    store: db.engine,
    memories: { list: (ownerId) => db.memory.getMemories(ownerId), save: (item) => db.memory.saveMemory(item), ...indexing },
    unseal: (sealed) => sealed.replace(/^sealed:/, ''),
    push, mail, now: () => '2026-10-29T11:00:00.000Z', log: () => undefined,
  });
  await db.engine.openRunReads('grant-1', 'owner', 'run-1', 'k', POISONING_AT);
  await db.engine.openRunReads('grant-1', 'owner', 'child-1', 'k', POISONING_AT);
  return { db, poisoning, push, mail };
}
