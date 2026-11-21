import { grantChanges, handOffsShippedBy, type GrantKind, type PersonaRecord, type ToolGrant } from '@koala/agent-engine';

export interface HandOffGrantMigrationStore {
  getEnginePersonas(): Promise<PersonaRecord[]>;
  saveEnginePersona(persona: PersonaRecord): Promise<void>;
  getToolGrants(ownerId: string): Promise<ToolGrant[]>;
  saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void>;
  deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void>;
}

export interface HandOffGrantMigration {
  agents: number;
  granted: number;
  revoked: number;
}

const MIGRATED_WHY = 'handed work to by this agent before hand-offs were granted';

export async function migrateAgentHandOffs(store: HandOffGrantMigrationStore, builtIn: readonly PersonaRecord[], now: string): Promise<HandOffGrantMigration> {
  const shipped = handOffsShippedBy(builtIn);
  const moved: HandOffGrantMigration = { agents: 0, granted: 0, revoked: 0 };
  for (const row of await store.getEnginePersonas()) {
    if (row.agents === undefined) continue;
    const ownerId = row.ownerId;
    if (ownerId !== undefined) {
      const wanted = row.agents.filter((agent): agent is string => typeof agent === 'string');
      const changes = grantChanges(row.slug, wanted, shipped, await store.getToolGrants(ownerId), 'agent');
      for (const target of changes.drop) await store.deleteToolGrant(ownerId, row.slug, target, 'agent');
      for (const target of changes.grant) await store.saveToolGrant({ ownerId, agent: row.slug, tool: target, kind: 'agent', grantedAt: now, why: MIGRATED_WHY });
      for (const target of changes.revoke) await store.saveToolGrant({ ownerId, agent: row.slug, tool: target, kind: 'agent', revoked: true, grantedAt: now, why: MIGRATED_WHY });
      moved.granted += changes.grant.length;
      moved.revoked += changes.revoke.length;
    }
    const { agents: _agents, ...kept } = row;
    await store.saveEnginePersona(kept);
    moved.agents += 1;
  }
  return moved;
}
