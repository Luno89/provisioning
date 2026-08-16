import 'dotenv/config';
import { createDatabase } from './lib/db-interface.js';
const db = createDatabase(); await db.init();
const ls = (await db.getLeaves()).filter((l: any) => l.branchId === '42784df9-61c8-46b7-8f24-96daef89e71c');
const c: Record<string, number> = {};
for (const l of ls) c[l.status] = (c[l.status] ?? 0) + 1;
console.log(JSON.stringify(c), '|', ls.map((l: any) => `${l.status[0]}:${l.title.slice(0,28)}`).join(' / '));
await db.close(); process.exit(0);
