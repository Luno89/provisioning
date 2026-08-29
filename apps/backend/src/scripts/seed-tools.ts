#!/usr/bin/env tsx

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
