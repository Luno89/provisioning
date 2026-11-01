import { createDatabase } from '../platform/index.js';

async function main() {
  const db = createDatabase();
  await db.init();
  const endpoints = await db.models.getModelEndpoints();
  console.log('Model endpoints:', endpoints.length);
  for (const endpoint of endpoints) {
    console.log({
      id: endpoint.id,
      ownerId: endpoint.ownerId,
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      contextTokens: endpoint.contextTokens,
      lastError: endpoint.lastError,
    });
  }
  await db.close();
}

main().catch(console.error).finally(() => process.exit(0));
