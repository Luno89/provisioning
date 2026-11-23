import { asPerson, type Principal } from '../../platform/lib/permissions.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { RunGrantService, type RunGrantDeps } from '../services/RunGrantService.js';
import { RunTokens, type RunTokenStore } from '../services/RunTokens.js';

export const tokensNotAsked = (store: RunTokenStore): RunTokens =>
  new RunTokens({ store, root: { none: 'these tests ask root for no run token' }, dataKey: 'run-grants-test-key', log: () => undefined, refusals: refusalsFail });

export const refusalsFail = { refused: (dependency: string, reason: string): void => { throw new Error(`these tests expect nothing refused for good, yet ${dependency} refused: ${reason}`); } };

export const grantsOver = (store: RunGrantDeps['store'] & RunTokenStore, over: Omit<Partial<RunGrantDeps>, 'store'> = {}): RunGrantService =>
  new RunGrantService({ store, tokens: tokensNotAsked(store), ...over });

export const grantsActingAsOwner = (store: RunGrantDeps['store'] & RunTokenStore) => ({
  grants: grantsOver(store),
  principal: async (ownerId: string): Promise<Principal> => asPerson(ownerId),
});

export const grantsHeldInMemory =(): RunGrantService => grantsOver(memoryDatabase().engine);

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
