import { createDatabase } from '../lib/db-interface.js';

async function main() {
  const db = createDatabase();
  await db.init();
  const mongoDb = db as any;
  if (!mongoDb.models) {
    console.log('No models collection');
    return;
  }
  const models = await mongoDb.models.find({}).toArray();
  console.log('Models count:', models.length);
  for (const m of models) {
    console.log({
      id: m._id,
      name: m.name,
      label: m.label,
      provider: m.provider,
      baseUrl: m.baseUrl,
      apiModelId: m.apiModelId,
      model: m.model,
      capabilities: m.capabilities,
    });
  }
}

main().catch(console.error).finally(() => process.exit(0));
