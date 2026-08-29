import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { createDatabase } from '../lib/db-interface.js';
import { createWebTools, renderSearchOutcome } from '../lib/web-tools.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { handleInspectResources, handleClusterCapacity } from '../lib/koala-tool-handlers.js';
import { InfrastructureService } from '../services/InfrastructureService.js';

const line = () => console.log('─'.repeat(76));

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();

  try {
    const ownerId = (await db.getDeployments())[0]?.ownerId;
    if (!ownerId) return console.log('No deployments — nothing to verify against.');

    line();
    console.log('SEARCH — the real deployment:');
    const real = await buildWebTools(db, ownerId);
    if (real) {
      console.log(`  sources: ${JSON.stringify(real.sources)}`);
      const out = await real.search('OpenUI');
      console.log(`  ${JSON.stringify(renderSearchOutcome('OpenUI', out)).slice(0, 220)}`);
    } else {
      console.log('  no web tools resolved for this owner');
    }

    line();
    console.log('SEARCH — SearXNG unreachable AND the fallback failing:');
    const broken = createWebTools({
      searxngUrl: 'http://127.0.0.1:1',
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    });
    const down = await broken.search('OpenUI');
    console.log(`  ${JSON.stringify(renderSearchOutcome('OpenUI', down))}`);
    console.log(`  -> says unavailable rather than "no results": ${down.unavailable ? 'YES' : 'NO'}`);

    line();
    console.log('KOALA cluster reads (live):');
    const infra = new InfrastructureService();
    const ctx = {
      db, userId: ownerId, conversationId: 'verify', sessionId: 'verify', servers: [],
      kubectl: (a: string[]) => infra.runKubectl(a).then((r: any) => (typeof r === 'string' ? r : (r?.stdout ?? ''))),
    } as never;

    const capacity = await handleClusterCapacity(ctx, {});
    console.log(`  cluster_capacity -> ${String((capacity as any).content ?? JSON.stringify(capacity)).replace(/\\n/g, ' ').slice(0, 200)}`);

    const dep = (await db.getDeployments()).find((d: any) => d.ownerId === ownerId && d.status === 'running');
    const pods = await handleInspectResources(ctx, { verb: 'get', resource: 'pods', target: dep?.name });
    console.log(`  inspect_resources(pods in ${dep?.name}) -> ${String((pods as any).content ?? '').replace(/\\n/g, ' ').slice(0, 200)}`);

    const refused = await handleInspectResources(ctx, { verb: 'get', resource: 'secrets', target: dep?.name });
    console.log(`  inspect_resources(secrets) -> ${String((refused as any).content ?? '').slice(0, 160)}`);

    const foreign = await handleInspectResources(ctx, { verb: 'get', resource: 'pods', target: 'kube-system' });
    console.log(`  inspect_resources(kube-system) -> ${String((foreign as any).content ?? '').slice(0, 160)}`);
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
