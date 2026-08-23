/**
 * Runs one consolidation pass against the real bank.
 *
 *   npx tsx apps/backend/src/scripts/memory-consolidate-once.ts          # dry run, writes nothing
 *   npx tsx apps/backend/src/scripts/memory-consolidate-once.ts --apply  # actually writes
 *
 * ── WHY A DRY RUN EXISTS ──
 * The pass runs unattended on a timer and edits the store every other subsystem reads. Being able
 * to see what it WOULD do, against real data, before believing it — and before the backend restarts
 * and does it on its own — is the difference between a reviewed change and a surprise. The dry run
 * needs no special support in the pass itself: it is the same code with a database that collects
 * writes instead of applying them.
 */
import { createDatabase } from '../lib/db-interface.js';
import { consolidateMemories } from '../lib/memory-consolidate.js';
import { corpusEndpoints } from '../lib/web-tools-resolver.js';
import { indexMemories, similarTo } from '../lib/memory-index.js';
import type { MemoryItem } from '../lib/memory-store.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const db = createDatabase();
  await db.init();

  try {
    const before = await db.getMemories();
    const ownerId = before[0]?.ownerId;
    const ends = ownerId ? await corpusEndpoints(db, ownerId).catch(() => undefined) : undefined;

    console.log(`\n${apply ? 'APPLYING' : 'DRY RUN — nothing will be written'}`);
    console.log(`Bank: ${before.length} memories, ${before.filter((m) => !m.invalidAt).length} current.`);
    console.log(`Vectors: ${ends?.vectors ? 'yes' : 'no'} — similarity dedupe ${ends?.vectors ? 'on' : 'off (titles only)'}\n`);

    const written: MemoryItem[] = [];
    const report = await consolidateMemories({
      db: {
        getMemories: () => db.getMemories(),
        getLeaves: () => db.getLeaves() as never,
        saveMemory: async (m: MemoryItem) => {
          written.push(m);
          if (apply) await db.saveMemory(m);
        },
      },
      ...(ends ? {
        // Never indexed on a dry run: the index is disposable, but writing to it would still make
        // the "nothing will be written" promise false.
        ...(apply ? { index: (items: MemoryItem[]) => indexMemories(ends, items) } : {}),
        similar: async (ids: string[]) => {
          const out = new Map<string, { id: string; score: number }[]>();
          for (const id of ids) out.set(id, await similarTo(ends, id, { ownerId: ownerId! }).catch(() => []));
          return out;
        },
      } : {}),
    });

    const retired = written.filter((m) => m.invalidAt);
    const added = written.filter((m) => !m.invalidAt);

    console.log(`RETIRING ${retired.length}:`);
    for (const m of retired.slice(0, 40)) {
      console.log(`  ${m.supersededBy ? 'duplicate of' : 'unused    '} ${m.supersededBy ?? '—'}  "${m.title}"`);
    }
    if (retired.length > 40) console.log(`  … and ${retired.length - 40} more`);

    console.log(`\nADDING ${added.length}:`);
    for (const m of added) console.log(`  "${m.title}"`);

    console.log(`\nResult: ${report.live} live, deduped ${report.deduped}, promoted ${report.promoted},`
      + ` decayed ${report.decayed}, indexed ${report.indexed}`);
    if (!apply) console.log('\nNothing was written. Re-run with --apply to keep this.');
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
