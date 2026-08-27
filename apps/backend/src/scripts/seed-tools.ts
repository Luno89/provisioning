#!/usr/bin/env tsx
/**
 * seed-tools.ts — Seeds all platform built-in tools and operational guidance into MongoDB.
 *
 * Usage: npx tsx src/scripts/seed-tools.ts
 */

import { createDatabase } from '../lib/db-interface.js';
import { seedTools } from '../lib/tool-seeds.js';

async function main() {
  const db = createDatabase();
  await db.init();

  try {
    const count = await seedTools(db);
    console.log(`[seed-tools] Successfully seeded/updated ${count} tools in database.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[seed-tools] Failed:', err);
  process.exit(1);
});
