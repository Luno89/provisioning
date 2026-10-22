#!/usr/bin/env tsx

import { createDatabase } from '../platform/lib/db-interface.js';
import { seedBindingTypes } from '../infrastructure/lib/binding-type-seeds.js';
import { seedAppSpecs, seedConstructBackedTypes } from '../infrastructure/lib/app-spec.js';
import { seedClusterProviders } from '../infrastructure/lib/cluster-providers.js';
import { seedTreeTypes, stampTreeVersions } from '../projects/lib/tree-types.js';
import { seedWorkspaceImages } from '../engine/lib/workspace-image-seeds.js';
import { retireStoredBuiltInProcedures } from '../engine/lib/built-in-procedures.js';
import { retireStoredBuiltInPersonas } from '../engine/lib/built-in-personas.js';
import { seedEngineTools } from '../engine/wiring/engine-tool-seeds.js';
import { migrateAgentTools } from '../engine/lib/tool-grant-migration.js';
import { migrateMcpServers } from '../engine/lib/mcp-server-migration.js';
import { migrateToDependencies } from '../engine/lib/dependency-migration.js';
import { SHIPPED_DEPENDENCIES } from '../extensions/workspace-dependencies.js';
import { seededGrants, seededPersonas } from '../extensions/seeds.js';
import { runOnce, type MigrationLedger } from '../platform/lib/migrations.js';

export async function seedAll(db: Record<string, unknown>) {
  const counts: Record<string, number> = {};
  counts.bindingTypes = await seedBindingTypes(db as never);
  // Images before tree types: a tree type's language must name one that exists.
  counts.workspaceImages = await seedWorkspaceImages(db as never);
  counts.treeTypes = await seedTreeTypes(db as never);
  const ledger = db as unknown as MigrationLedger;
  const now = new Date().toISOString();
  counts.treeVersionsStamped = (await runOnce(ledger, 'tree-versions', now, async () => ({ stamped: await stampTreeVersions(db as never) }))).stamped ?? 0;
  counts.appSpecs = await seedAppSpecs(db as never);
  counts.constructBackedTypes = await seedConstructBackedTypes(db as never);
  counts.clusterProviders = await seedClusterProviders(db as never);
  counts.removedBuiltInProcedures = await retireStoredBuiltInProcedures(db as never);
  counts.engineTools = await seedEngineTools(db as never);
  counts.removedBuiltInPersonas = await retireStoredBuiltInPersonas(db as never);
  Object.assign(counts, { agentToolListsMoved: 0, toolGrantsWritten: 0, builtInCopiesDropped: 0 }, await runOnce(ledger, 'tool-grants', now, async () => {
    const moved = await migrateAgentTools(db as never, seededPersonas(), seededGrants(), now);
    return { agentToolListsMoved: moved.agents, toolGrantsWritten: moved.granted + moved.revoked, builtInCopiesDropped: moved.copiesDropped };
  }));
  Object.assign(counts, { agentServerListsMoved: 0, servingToolsMoved: 0, mcpToolKindsMoved: 0 }, await runOnce(ledger, 'mcp-servers', now, async () => {
    const servers = await migrateMcpServers(db as never, now);
    return { agentServerListsMoved: servers.agentServerListsMoved, servingToolsMoved: servers.servingToolsMoved, mcpToolKindsMoved: servers.toolKindsMoved };
  }));
  Object.assign(counts, { toolsNamingNeeds: 0, serversNamingNeeds: 0, dependenciesMade: 0 }, await runOnce(ledger, 'workspace-dependencies', now, async () => {
    const needs = await migrateToDependencies(db as never, SHIPPED_DEPENDENCIES);
    for (const left of needs.left) console.warn(`[seed] left as it was: ${left}`);
    return { toolsNamingNeeds: needs.toolsMoved, serversNamingNeeds: needs.serversMoved, dependenciesMade: needs.dependenciesMade };
  }));
  return counts;
}

async function main() {
  const db = createDatabase();
  await db.init();
  try {
    const counts = await seedAll(db as never);
    const written = Object.entries(counts).filter(([, n]) => n > 0);
    console.log(written.length
      ? `[seed] ${written.map(([k, n]) => `${k}=${n}`).join(' ')}`
      : '[seed] everything already up to date');
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('seed-all.ts')) {
  main().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
