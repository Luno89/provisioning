#!/usr/bin/env tsx

import { createDatabase } from '../lib/db-interface.js';
import { seedBindingTypes } from '../lib/binding-type-seeds.js';
import { seedAppSpecs, seedConstructBackedTypes } from '../lib/app-spec.js';
import { seedClusterProviders } from '../lib/cluster-providers.js';
import { seedTreeTypes, stampTreeVersions } from '../lib/tree-types.js';
import { seedWorkspaceImages } from '../lib/workspace-image-seeds.js';
import { retireStoredBuiltInProcedures } from '../lib/built-in-procedures.js';
import { retireStoredBuiltInPersonas } from '../lib/built-in-personas.js';
import { seedEngineTools } from '../wiring/engine-tool-seeds.js';
import { migrateAgentTools } from '../lib/tool-grant-migration.js';
import { migrateMcpServers } from '../lib/mcp-server-migration.js';
import { migrateToDependencies } from '../lib/dependency-migration.js';
import { SHIPPED_DEPENDENCIES } from '../extensions/workspace-dependencies.js';
import { seededGrants, seededPersonas } from '../extensions/seeds.js';

export async function seedAll(db: Record<string, unknown>) {
  const counts: Record<string, number> = {};
  counts.bindingTypes = await seedBindingTypes(db as never);
  // Images before tree types: a tree type's language must name one that exists.
  counts.workspaceImages = await seedWorkspaceImages(db as never);
  counts.treeTypes = await seedTreeTypes(db as never);
  counts.treeVersionsStamped = await stampTreeVersions(db as never);
  counts.appSpecs = await seedAppSpecs(db as never);
  counts.constructBackedTypes = await seedConstructBackedTypes(db as never);
  counts.clusterProviders = await seedClusterProviders(db as never);
  counts.removedBuiltInProcedures = await retireStoredBuiltInProcedures(db as never);
  counts.engineTools = await seedEngineTools(db as never);
  counts.removedBuiltInPersonas = await retireStoredBuiltInPersonas(db as never);
  const moved = await migrateAgentTools(db as never, seededPersonas(), seededGrants(), new Date().toISOString());
  counts.agentToolListsMoved = moved.agents;
  counts.toolGrantsWritten = moved.granted + moved.revoked;
  counts.builtInCopiesDropped = moved.copiesDropped;
  const servers = await migrateMcpServers(db as never, new Date().toISOString());
  counts.agentServerListsMoved = servers.agentServerListsMoved;
  counts.servingToolsMoved = servers.servingToolsMoved;
  counts.mcpToolKindsMoved = servers.toolKindsMoved;
  const needs = await migrateToDependencies(db as never, SHIPPED_DEPENDENCIES);
  counts.toolsNamingNeeds = needs.toolsMoved;
  counts.serversNamingNeeds = needs.serversMoved;
  counts.dependenciesMade = needs.dependenciesMade;
  for (const left of needs.left) console.warn(`[seed] left as it was: ${left}`);
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
