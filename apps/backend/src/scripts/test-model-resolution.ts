import { createDatabase } from '../platform/lib/db-interface.js';

async function main() {
  const db = createDatabase();
  await db.init();
  
  const endpoints = await db.models.getModelEndpoints();
  const tabbyEps = endpoints.filter((e) => e.name.toLowerCase().includes('tabby'));
  console.log('Tabby endpoints:', tabbyEps);

  const personas = await db.engine.getEnginePersonas('bbd5483a-16ca-4dfb-a865-757c064b5b75');
  console.log('Stored personas for user:', personas.map((p) => ({ slug: p.slug, ownerId: p.ownerId })));
  const allPersonas = await db.engine.getEnginePersonas();
  console.log('All stored personas:', allPersonas.map((p) => ({ slug: p.slug, ownerId: p.ownerId })));
}

main().catch(console.error).finally(() => process.exit(0));
