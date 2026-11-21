import { asPerson, type Principal } from '../../platform/lib/permissions.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { RunGrantService } from '../services/RunGrantService.js';

export const grantsHeldInMemory = (): RunGrantService => new RunGrantService({ store: memoryDatabase().engine });

export async function grantHeld(grants: RunGrantService, over: { ownerId?: string; runId?: string; principal?: Principal } = {}): Promise<string> {
  const ownerId = over.ownerId ?? 'user-1';
  const grant = await grants.issue({ ownerId, runId: over.runId ?? 'run-1', principal: over.principal ?? asPerson(ownerId), startedBy: 'person' });
  return grant.id;
}

export const runsActingAsTheirOwner = (grants: RunGrantService = grantsHeldInMemory()) => ({
  grants,
  principal: async (ownerId: string): Promise<Principal> => asPerson(ownerId),
});

export const hostGrants = (grants: RunGrantService = grantsHeldInMemory()) => ({
  check: (grantId: string, tool: string, projectId: string | undefined) => grants.check(grantId, tool, projectId),
  grant: (id: string) => grants.grant(id),
  keepHandover: (ownerId: string, runId: string, handover: Parameters<RunGrantService['keepHandover']>[2]) => grants.keepHandover(ownerId, runId, handover),
});
