/**
 * Proves hybrid recall on the real bank, against the real services, changing nothing.
 *
 *   npx tsx apps/backend/src/scripts/memory-smoke.ts [query...]
 *
 * ── WHY THIS EXISTS BEFORE ANYTHING DEPENDS ON IT ──
 * Every claim made for relevance retrieval is a claim about ordering, and ordering is exactly what
 * unit tests cannot check: they can prove that a ranked list is respected, not that the ranking is
 * any good. This runs real leaf-shaped questions against the real 125-memory bank and prints what
 * recall would inject beside what the old recency ordering would have injected, so the difference
 * is a thing you can read rather than a thing the design asserts.
 *
 * ── AND WHY IT IS SAFE TO RUN ──
 * It writes to Qdrant and Quickwit, which are disposable indexes rebuildable from Mongo at any
 * time, and it writes NOTHING to Mongo — no `lastUsedAt`, no new memories, no invalidation. The
 * memory bank is exactly as it was when this exits.
 */
import { createDatabase } from '../lib/db-interface.js';
import { corpusEndpoints } from '../lib/web-tools-resolver.js';
import { indexMemories, searchMemories } from '../lib/memory-index.js';
import { recallMemories, recallQuery } from '../lib/memory-recall.js';
import { buildMemoryContext, type MemoryItem } from '../lib/memory-store.js';

/** Leaf-shaped questions: the kind of thing a planner actually writes as a title. */
const DEFAULT_QUERIES = [
  'Add rate limiting to the upload route',
  'The build failed because a command was missing from the sandbox image',
  'Write a new module into the existing project repository',
];

const titles = (items: MemoryItem[]) => items.map((m) => `${m.title} [${m.id.slice(-6)}]`);

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();

  try {
    const all = await db.getMemories();
    const owners = [...new Set(all.map((m) => m.ownerId))];
    console.log(`\nBank: ${all.length} memories across ${owners.length} owner(s).`);
    console.log(`  active: ${all.filter((m) => m.status !== 'pending_review' && !m.invalidAt).length}`
      + `  pending_review: ${all.filter((m) => m.status === 'pending_review').length}`
      + `  invalidated: ${all.filter((m) => m.invalidAt).length}`);

    // The owner with the most memories — the one whose bank can actually demonstrate a ranking.
    const ownerId = owners.sort((a, b) =>
      all.filter((m) => m.ownerId === b).length - all.filter((m) => m.ownerId === a).length)[0];
    if (!ownerId) return console.log('Nothing stored. Run a leaf first.');

    const mine = all.filter((m) => m.ownerId === ownerId);

    /**
     * A project, because without one nothing is injected at all.
     *
     * Every memory in this bank is project-scoped, and `selectForContext` gives a leaf with NO
     * project none of them — that is the cross-project leak fix, working. Running this script
     * without a project therefore prints an empty block for both orderings and measures nothing.
     */
    const counts = new Map<string, number>();
    for (const m of mine) {
      /**
       * Counted on what could actually be INJECTED, not on what is stored.
       *
       * Picking the project with the most rows chose one whose entries were all held over from the
       * old review queue, so both orderings printed a single memory and the comparison measured
       * nothing. Relevance can only be demonstrated where there is more than one candidate.
       */
      if (m.projectId && !m.invalidAt && m.status !== 'pending_review') {
        counts.set(m.projectId, (counts.get(m.projectId) ?? 0) + 1);
      }
    }
    const projectId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    console.log(`\nUsing owner ${ownerId} (${mine.length} memories), project ${projectId ?? '(none)'} `
      + `(${projectId ? counts.get(projectId) : 0} injectable memories).`);

    const ends = await corpusEndpoints(db, ownerId);
    console.log(`Endpoints — vectors: ${ends.vectors ? 'yes' : 'NO'}`
      + `  index: ${ends.index ? 'yes' : 'NO'}  embeddings: ${ends.embeddings ? 'yes' : 'NO'}`);
    if (!ends.vectors && !ends.index) {
      return console.log('\nNeither half is deployed — recall degrades to recency, which is the '
        + 'documented fallback. Nothing to measure here.');
    }

    // Everything currently true. Invalidated rows are history and are deliberately not indexed.
    const live = mine.filter((m) => !m.invalidAt);
    console.log(`\nIndexing ${live.length} live memories…`);
    const written = await indexMemories(ends, live);
    console.log(`  vectors: ${written.vectors}  documents: ${written.documents}`);

    for (const query of (process.argv.slice(2).length ? [process.argv.slice(2).join(' ')] : DEFAULT_QUERIES)) {
      console.log(`\n${'─'.repeat(78)}\nQUERY: ${query}`);

      const began = Date.now();
      const hits = await searchMemories(ends, recallQuery({ title: query }), { ownerId });
      console.log(`  search: ${hits.length} candidates in ${Date.now() - began}ms`);
      for (const h of hits.slice(0, 5)) {
        const m = mine.find((x) => x.id === h.id);
        console.log(`    ${h.score.toFixed(4)}  [${h.via.join('+')}]  ${m ? m.title : '(not in Mongo)'}`);
      }

      const recalled = await recallMemories({
        memories: mine, ownerId, projectId, query: recallQuery({ title: query }), endpoints: async () => ends,
      });
      const before = buildMemoryContext(mine, projectId);

      console.log(`  via: ${recalled.via}`);
      console.log(`  RELEVANCE injects: ${titles(recalled.selected).join(' | ') || '(nothing)'}`);
      console.log(`  RECENCY  injected: ${before.split('\n').filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).split(':')[0]).join(' | ') || '(nothing)'}`);
    }

    /**
     * The claim that matters most, checked rather than asserted: a dead service must cost a leaf
     * nothing but the relevance ordering.
     */
    console.log(`\n${'─'.repeat(78)}\nDEGRADATION — pointing recall at a dead port:`);
    const began = Date.now();
    const dead = await recallMemories({
      memories: mine, ownerId, projectId, query: 'anything at all',
      endpoints: async () => ({ vectors: { base: 'http://127.0.0.1:1', apiKey: 'x' }, embeddings: { base: 'http://127.0.0.1:1' } }),
    });
    console.log(`  via: ${dead.via}  in ${Date.now() - began}ms  injected ${dead.selected.length} memories`);
    console.log(`  identical to the old recency block: ${dead.context === buildMemoryContext(mine, projectId)}`);
  } finally {
    await db.close();
  }
}

/**
 * Exits explicitly.
 *
 * `corpusEndpoints` establishes kubectl port-forwards, which are long-lived child processes held
 * open for the backend's benefit. Nothing here can close them without closing them for the running
 * server too, so the script says it is done rather than waiting for an event loop that will not
 * drain. Measured: without this it hangs forever after printing every result correctly.
 */
main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
