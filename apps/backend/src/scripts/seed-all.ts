#!/usr/bin/env tsx

import { createDatabase } from '../lib/db-interface.js';
import { seedTools } from '../lib/tool-seeds.js';
import { seedBindingTypes } from '../lib/binding-type-seeds.js';
import { seedPersonas } from '../lib/persona-seeds.js';
import { seedPacks } from '../lib/pack-seeds.js';
import { seedAppSpecs } from '../lib/app-spec.js';
import { seedClusterProviders } from '../lib/cluster-providers.js';
import { seedTreeTypes } from '../lib/tree-types.js';
import { seedWorkspaceImages } from '../lib/workspace-image-seeds.js';

export async function seedAll(db: Parameters<typeof seedTools>[0] & Record<string, unknown>) {
  const counts: Record<string, number> = {};
  counts.tools = await seedTools(db as never);
  counts.bindingTypes = await seedBindingTypes(db as never);
  // Images before tree types: a tree type's language must name one that exists.
  counts.workspaceImages = await seedWorkspaceImages(db as never);
  counts.treeTypes = await seedTreeTypes(db as never);
  counts.appSpecs = await seedAppSpecs(db as never);
  counts.clusterProviders = await seedClusterProviders(db as never);
  // Personas before packs: a pack resolves its persona by name at seed time and is SKIPPED when
  // that persona is absent, which would leave an account with no packs at all.
  counts.personas = await seedPersonas(db as never);
  counts.packs = await seedPacks(db as never);
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
