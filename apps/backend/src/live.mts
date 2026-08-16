import 'dotenv/config';
import { createDatabase } from './lib/db-interface.js';
const db = createDatabase(); await db.init();
const l: any = (await db.getLeaves()).find((x: any) =>
  x.branchId === '42784df9-61c8-46b7-8f24-96daef89e71c' && x.status === 'running');
if (!l) { console.log('nothing running'); await db.close(); process.exit(0); }
const t = await db.getLeafTrace(l.id);
console.log(`${l.title} — ${t?.steps.length ?? 0} turns so far`);
for (const s of (t?.steps ?? []).slice(-6)) {
  let lbl = '';
  for (const c of s.toolCalls) {
    try { const a = JSON.parse(c.arguments); lbl = String(a.command || a.path || '').slice(0, 60); }
    catch { lbl = c.arguments.slice(0, 45); }
    break;
  }
  console.log(`  ${s.step} ${(s.toolCalls.map((c) => c.name).join(',') || '(prose)').padEnd(12)} ${lbl}`);
}
await db.close(); process.exit(0);
