import { createDatabase } from '../lib/db-interface.js';
import { ModelService } from '../services/ModelService.js';

async function main() {
  const db = createDatabase();
  await db.init();
  const modelService = new ModelService(db, { getAll: async () => [] } as any, {} as any, {} as any, {} as any, 'secret');
  
  const endpoints = await db.getModelEndpoints();
  const tabbyEps = endpoints.filter((e) => e.name.toLowerCase().includes('tabby'));
  console.log('Tabby endpoints:', tabbyEps);

  const mongo = db as any;
  const personas = await db.getEnginePersonas('bbd5483a-16ca-4dfb-a865-757c064b5b75');
  console.log('Stored personas for user:', personas.map((p) => ({ slug: p.slug, ownerId: p.ownerId })));
  const allPersonas = await db.getEnginePersonas();
  console.log('All stored personas:', allPersonas.map((p) => ({ slug: p.slug, ownerId: p.ownerId })));
}

main().catch(console.error).finally(() => process.exit(0));
