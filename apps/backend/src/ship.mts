import 'dotenv/config';
import { createDatabase } from './lib/db-interface.js';
import { shippingGaps, deploysItself } from './lib/project-shipping.js';
const db = createDatabase(); await db.init();
for (const p of await db.getProjects()) {
  const g = shippingGaps(p as any);
  console.log(`${String(p.name).padEnd(26)} gaps=${g.length ? g.join('; ') : 'none'} | selfDeploys=${deploysItself(p as any)} | target=${(p as any).targetClusterId ?? '-'}`);
}
console.log('\npipeline runs:');
for (const r of (await db.getPipelineRuns()).slice(-4)) console.log(' ', r.status, r.ref, String(r.commitSha).slice(0,8), r.imageTag ?? '');
await db.close(); process.exit(0);
