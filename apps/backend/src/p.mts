import 'dotenv/config';
import { createDatabase } from './lib/db-interface.js';
const db = createDatabase(); await db.init();
const rs = (await db.getPipelineRuns()).slice(-2);
console.log(rs.map((r: any) => `${r.ref}=${r.status}`).join(' | '));
await db.close(); process.exit(0);
