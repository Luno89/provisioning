import { grantChanges, toRecord, type PersonaRecord, type ToolGrant } from '@koala/agent-engine';
import { sameSeededRow } from './seed-diff.js';

export interface ToolGrantMigrationStore {
  getEnginePersonas(): Promise<PersonaRecord[]>;
  saveEnginePersona(persona: PersonaRecord): Promise<void>;
  deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void>;
  getToolGrants(ownerId: string): Promise<ToolGrant[]>;
  saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void>;
  deleteToolGrant(ownerId: string, agent: string, tool: string): Promise<void>;
}

export interface ToolGrantMigration {
  agents: number;
  granted: number;
  revoked: number;
  copiesDropped: number;
}

const MIGRATED_WHY = 'held by this agent before tools were granted';

export async function migrateAgentTools(
  store: ToolGrantMigrationStore,
  builtIn: readonly PersonaRecord[],
  shipped: readonly ToolGrant[],
  now: string,
): Promise<ToolGrantMigration> {
  const moved: ToolGrantMigration = { agents: 0, granted: 0, revoked: 0, copiesDropped: 0 };
  for (const row of await store.getEnginePersonas()) {
    const listed = (row as PersonaRecord & { tools?: unknown }).tools;
    if (listed === undefined) continue;
    const ownerId = row.ownerId;
    if (ownerId !== undefined && Array.isArray(listed)) {
      const wanted = listed.filter((tool): tool is string => typeof tool === 'string');
      const changes = grantChanges(row.slug, wanted, shipped, await store.getToolGrants(ownerId));
      for (const tool of changes.drop) await store.deleteToolGrant(ownerId, row.slug, tool);
      for (const tool of changes.grant) await store.saveToolGrant({ ownerId, agent: row.slug, tool, grantedAt: now, why: MIGRATED_WHY });
      for (const tool of changes.revoke) await store.saveToolGrant({ ownerId, agent: row.slug, tool, revoked: true, grantedAt: now, why: MIGRATED_WHY });
      moved.granted += changes.grant.length;
      moved.revoked += changes.revoke.length;
    }
    const record = toRecord(row as PersonaRecord & { tools: string[] });
    const original = builtIn.find((one) => one.slug === row.slug);
    if (ownerId !== undefined && original && sameSeededRow({ ...original, ownerId: undefined }, { ...record, ownerId: undefined })) {
      await store.deleteEnginePersona(ownerId, row.slug);
      moved.copiesDropped += 1;
    } else {
      await store.saveEnginePersona(record);
    }
    moved.agents += 1;
  }
  return moved;
}
