import { describe, it, expect } from 'vitest';
import { buildMemoryContext, MAX_MEMORY_CONTEXT_CHARS, type MemoryItem,
  unreachableMemory,
} from './memory-store.js';

const mem = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'm1', ownerId: 'u1', category: 'environment_facts',
  title: 'A fact', text: 'Something true about the repo.',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

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
    const out = buildMemoryContext(many(200));
    expect(out).toMatch(/\(\d+ older entries not shown/);
  });
});

describe('which memories win the budget', () => {
  it('prefers the project-scoped fact over the general one', () => {
    const items = [
      ...many(40, { scope: 'global' as const }),
      mem({ id: 'proj', scope: 'project', projectId: 'p1', title: 'THE PROJECT FACT', text: 'short' }),
    ];
    const out = buildMemoryContext(items, 'p1');
    expect(out).toContain('THE PROJECT FACT');
  });

  it('prefers the newer fact when scope is equal', () => {
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
    const out = buildMemoryContext([mem({ status: 'pending_review', title: 'INFERRED' })]);
    expect(out).toBe('');
  });

  it('leaves another project\'s memory out', () => {
    const out = buildMemoryContext([mem({ scope: 'project', projectId: 'other', title: 'THEIRS' })], 'mine');
    expect(out).toBe('');
  });

  it('gives a leaf with NO project none of the project-scoped memories', () => {
    const bank = Array.from({ length: 18 }, (_, i) => mem({
      id: `m${i}`, scope: 'project', projectId: `proj-${i}`, title: 'Repository layout',
    }));

    expect(buildMemoryContext(bank, undefined)).toBe('');
  });

  it('still gives a leaf its OWN project\'s memories', () => {
    const bank = [
      mem({ id: 'mine', scope: 'project', projectId: 'p1', title: 'MY LAYOUT' }),
      mem({ id: 'theirs', scope: 'project', projectId: 'p2', title: 'THEIR LAYOUT' }),
    ];
    const out = buildMemoryContext(bank, 'p1');

    expect(out).toContain('MY LAYOUT');
    expect(out).not.toContain('THEIR LAYOUT');
  });

  it('still gives a project-less leaf the GLOBAL memories', () => {
    const out = buildMemoryContext([mem({ scope: 'global', title: 'NODE 22 IS INSTALLED' })], undefined);
    expect(out).toContain('NODE 22 IS INSTALLED');
  });

  it('returns nothing at all when there is nothing to say', () => {
    expect(buildMemoryContext([])).toBe('');
  });

  it('reports the omission rather than an empty bank when every entry is oversized', () => {
    const out = buildMemoryContext([mem({ text: 'x'.repeat(MAX_MEMORY_CONTEXT_CHARS * 2) })]);
    expect(out).toContain('omitted');
    expect(out).not.toBe('');
  });
});

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
    expect(unreachableMemory({ ...base, scope: 'project' } as never)).toMatch(/projectId|global/);
  });
});
