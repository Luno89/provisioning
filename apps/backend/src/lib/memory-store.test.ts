import { describe, it, expect } from 'vitest';
import { buildMemoryContext, MAX_MEMORY_CONTEXT_CHARS, type MemoryItem,
  unreachableMemory,
} from './memory-store.js';

/**
 * The memory bank, and the one thing that made it dangerous: it had no size.
 *
 * This text is baked into the SYSTEM prompt, which is outside the region `trimConversation` may
 * touch — so it is the only part of a prompt that grows monotonically. Every finished run extracts
 * a memory, every memory joins every future prompt, and nothing ever dropped one. A trimmer working
 * hard on the messages while the system prompt expanded underneath it was fixing the wrong half.
 */

const mem = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'm1', ownerId: 'u1', category: 'environment_facts',
  title: 'A fact', text: 'Something true about the repo.',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

/** Enough entries to blow any sane budget several times over. */
const many = (n: number, over: Partial<MemoryItem> = {}) =>
  Array.from({ length: n }, (_, i) => mem({
    id: `m${i}`,
    title: `Fact ${i}`,
    text: 'x'.repeat(300),
    createdAt: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    ...over,
  }));

describe('what reaches the prompt', () => {
  it('is unchanged for a bank that comfortably fits', () => {
    const out = buildMemoryContext([mem({ title: 'Node 22', text: 'is installed' })]);
    expect(out).toContain('HARNESS MEMORY BANK:');
    expect(out).toContain('- Node 22: is installed');
    expect(out).not.toContain('not shown');
  });

  it('renders one bullet per memory, whatever the text contains', () => {
    /**
     * A promoted research finding is markdown — headings, lists, blank lines. Rendered verbatim it
     * became a dozen apparent bullets, most beginning mid-sentence, and an agent reading that
     * cannot tell where one memory ends and the next begins.
     */
    const out = buildMemoryContext([mem({
      title: 'What the research established',
      text: '# Heading\n\n- point one\n- point two\n\nA paragraph.',
    })]);

    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toBe('- What the research established: # Heading - point one - point two A paragraph.');
  });

  it('stays inside the budget however much is stored', () => {
    const out = buildMemoryContext(many(200));
    expect(out.length).toBeLessThan(MAX_MEMORY_CONTEXT_CHARS + 500);
  });

  it('says how much it left out, rather than eliding silently', () => {
    /**
     * An agent handed a quietly truncated bank will state confidently that something is not
     * recorded when it is. The count turns a wrong answer into a checkable one.
     */
    const out = buildMemoryContext(many(200));
    expect(out).toMatch(/\(\d+ older entries not shown/);
  });
});

describe('which memories win the budget', () => {
  it('prefers the project-scoped fact over the general one', () => {
    // "This repo's tests need a live Postgres" beats a general note about tests.
    const items = [
      ...many(40, { scope: 'global' as const }),
      mem({ id: 'proj', scope: 'project', projectId: 'p1', title: 'THE PROJECT FACT', text: 'short' }),
    ];
    const out = buildMemoryContext(items, 'p1');
    expect(out).toContain('THE PROJECT FACT');
  });

  it('prefers the newer fact when scope is equal', () => {
    // A layout re-extracted last week describes the current repo; the one it superseded does not.
    const items = [
      mem({ id: 'old', title: 'OLD LAYOUT', createdAt: '2020-01-01T00:00:00.000Z', text: 'y'.repeat(3000) }),
      mem({ id: 'new', title: 'NEW LAYOUT', createdAt: '2026-08-20T00:00:00.000Z', text: 'z'.repeat(3000) }),
    ];
    const out = buildMemoryContext(items);
    expect(out).toContain('NEW LAYOUT');
    expect(out).not.toContain('OLD LAYOUT');
  });
});

describe('what it still refuses to include', () => {
  it('leaves pending_review out, cap or no cap', () => {
    // The whole point of the review queue: nothing a model concluded reaches a future prompt
    // without somebody agreeing to it. The budget must not become a way around that.
    const out = buildMemoryContext([mem({ status: 'pending_review', title: 'INFERRED' })]);
    expect(out).toBe('');
  });

  it('leaves another project\'s memory out', () => {
    const out = buildMemoryContext([mem({ scope: 'project', projectId: 'other', title: 'THEIRS' })], 'mine');
    expect(out).toBe('');
  });

  /**
   * ── THE LEAK THIS FILE EXISTS TO PREVENT ──
   * The filter read `!projectId || m.projectId === projectId`, so a leaf with NO project matched
   * EVERY project-scoped memory. Every `repo: false` persona resolves no project — Researcher,
   * Framer, Synthesist, Reviewer, Judge — so that was most leaves.
   *
   * Measured live: 125 memories, all project-scoped, 18 active, every one of them a "Repository
   * layout" for a different project. A research leaf opened each prompt with eighteen unrelated
   * codebases' file listings presented as environment facts.
   *
   * The old test passed a MATCHING projectId and so never touched this branch, which is why the
   * bug survived being tested.
   */
  it('gives a leaf with NO project none of the project-scoped memories', () => {
    const bank = Array.from({ length: 18 }, (_, i) => mem({
      id: `m${i}`, scope: 'project', projectId: `proj-${i}`, title: 'Repository layout',
    }));

    expect(buildMemoryContext(bank, undefined)).toBe('');
  });

  it('still gives a leaf its OWN project\'s memories', () => {
    // The fix must not go the other way and starve a leaf that does have a project.
    const bank = [
      mem({ id: 'mine', scope: 'project', projectId: 'p1', title: 'MY LAYOUT' }),
      mem({ id: 'theirs', scope: 'project', projectId: 'p2', title: 'THEIR LAYOUT' }),
    ];
    const out = buildMemoryContext(bank, 'p1');

    expect(out).toContain('MY LAYOUT');
    expect(out).not.toContain('THEIR LAYOUT');
  });

  it('still gives a project-less leaf the GLOBAL memories', () => {
    // Global is the scope that means "applies everywhere", and a project-less leaf is everywhere.
    const out = buildMemoryContext([mem({ scope: 'global', title: 'NODE 22 IS INSTALLED' })], undefined);
    expect(out).toContain('NODE 22 IS INSTALLED');
  });

  it('returns nothing at all when there is nothing to say', () => {
    expect(buildMemoryContext([])).toBe('');
  });

  it('reports the omission rather than an empty bank when every entry is oversized', () => {
    // An empty bank reads as "there is nothing to know", which is a different and wrong claim.
    const out = buildMemoryContext([mem({ text: 'x'.repeat(MAX_MEMORY_CONTEXT_CHARS * 2) })]);
    expect(out).toContain('omitted');
    expect(out).not.toBe('');
  });
});

/**
 * ── A MEMORY NOBODY CAN READ SHOULD NOT BE WRITABLE ──
 *
 * `selectForContext` gives a project-scoped memory only to a leaf with that project:
 * `if (m.scope === 'project') return Boolean(projectId) && m.projectId === projectId`. So
 * `scope: 'project'` with no `projectId` is a row no caller can ever receive.
 *
 * The consolidation loop already sweeps them (`planUnreachable`), which was written after promotion
 * produced eleven of them. But `POST /api/harness/memories` could still create one — it defaulted
 * `scope` to `'project'` and left `projectId` undefined — so a manually saved memory would be
 * accepted, appear in the list, and quietly disappear on the next consolidation.
 *
 * Rejecting at the door rather than only sweeping afterwards: the sweep is a repair, and a repair
 * that runs on a hand-written record turns a mistake the person could have fixed into data loss
 * they never see.
 */
describe('a memory that could never be recalled', () => {
  const base = {
    id: 'm1', ownerId: 'u1', category: 'fact', title: 'T', text: 'x',
    source: 'manual', status: 'active', recommendedScope: 'project',
    createdAt: 'now', updatedAt: 'now',
  } as const;

  it('refuses project scope with no project', () => {
    expect(unreachableMemory({ ...base, scope: 'project' } as never)).toBeTruthy();
  });

  it('accepts project scope with a project', () => {
    expect(unreachableMemory({ ...base, scope: 'project', projectId: 'p1' } as never)).toBeUndefined();
  });

  it('accepts global scope with no project, which is what global means', () => {
    expect(unreachableMemory({ ...base, scope: 'global' } as never)).toBeUndefined();
  });

  it('says which field would fix it', () => {
    // A bare rejection makes the caller guess between changing the scope and adding the project.
    expect(unreachableMemory({ ...base, scope: 'project' } as never)).toMatch(/projectId|global/);
  });
});
