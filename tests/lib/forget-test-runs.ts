import type { Database } from '../../apps/backend/src/platform/lib/db-interface.js';

export async function forgetWhatRunsLeft(db: Database, ownerId: string, runIds: ReadonlySet<string>): Promise<number> {
  const at = new Date().toISOString();
  let forgotten = 0;
  for (const memory of await db.memory.getMemories(ownerId)) {
    if (memory.invalidAt || !memory.provenance?.experimentId || !runIds.has(memory.provenance.experimentId)) continue;
    await db.memory.saveMemory({ ...memory, invalidAt: at, updatedAt: at, text: `${memory.text}\n(retired: made by a live test, not by real use)` });
    forgotten += 1;
  }
  for (const collection of ['evalScenarioProposals', 'evalAgentChanges'] as const) {
    for (const record of await db.checks.getEvalRecords<{ id: string; ownerId: string; status: string; proposedBy?: string }>(collection, ownerId, 1000)) {
      if (!record.proposedBy || !runIds.has(record.proposedBy) || !['proposed', 'comparing', 'ready'].includes(record.status)) continue;
      await db.checks.saveEvalRecord(collection, { ...record, status: 'dismissed', decidedAt: at });
      forgotten += 1;
    }
  }
  return forgotten;
}
