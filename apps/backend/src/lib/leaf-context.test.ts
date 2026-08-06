import { describe, it, expect } from 'vitest';
import { buildLeafContext, MAX_CONTEXT_LEAVES , buildOutboundMessages } from './leaf-context.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Do a thing',
  column: 'todo', status: 'pending', depth: 0, blocking: true,
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
  ...over,
});

describe('buildLeafContext', () => {
  it('is empty for a branch with no leaves, so a fresh chat carries no dead weight', () => {
    expect(buildLeafContext([])).toBe('');
  });

  it('lists titles with plain-language status', () => {
    const ctx = buildLeafContext([leaf({ title: 'Add rate limiting', status: 'running' })]);
    expect(ctx).toContain('Add rate limiting');
    expect(ctx).toContain('in progress');
  });

  it('uses plain words, never the UI koala vocabulary', () => {
    // "Munching" means nothing to a model and would spend tokens on a joke it cannot get.
    const ctx = buildLeafContext([leaf({ status: 'running' }), leaf({ id: 'l2', status: 'succeeded' })]);
    expect(ctx).not.toMatch(/Munching|Digested|Sprouting|Bitter/);
  });

  it('tells the model not to repeat existing work', () => {
    // The visible symptom without this: the same leaves proposed again every single turn.
    expect(buildLeafContext([leaf()])).toMatch(/Do not propose work that is already listed/);
  });

  it('preserves the shape of the decomposition through indentation', () => {
    const ctx = buildLeafContext([
      leaf({ id: 'root', title: 'Parent', depth: 0 }),
      leaf({ id: 'kid', title: 'Child', depth: 1, createdAt: '2026-08-03T00:00:01Z' }),
    ]);
    const lines = ctx.split('\n');
    expect(lines.find((l) => l.includes('Parent'))!.startsWith('- ')).toBe(true);
    expect(lines.find((l) => l.includes('Child'))!.startsWith('  - ')).toBe(true);
  });

  it('omits bodies, which would dominate the context', () => {
    const ctx = buildLeafContext([leaf({ body: 'A very long description that should not appear.' })]);
    expect(ctx).not.toContain('should not appear');
  });

  it('caps a large branch and says how many were left out', () => {
    const many = Array.from({ length: MAX_CONTEXT_LEAVES + 12 }, (_, i) =>
      leaf({ id: `l${i}`, title: `Leaf ${i}`, createdAt: `2026-08-03T00:00:${String(i).padStart(2, '0')}Z` }));
    const ctx = buildLeafContext(many);
    expect(ctx).toMatch(/…and 12 more/);
    expect(ctx.split('\n').filter((l) => l.trim().startsWith('- ')).length).toBe(MAX_CONTEXT_LEAVES);
  });

  it('handles an unknown status without producing "undefined"', () => {
    const ctx = buildLeafContext([leaf({ status: 'weird' as any })]);
    expect(ctx).not.toContain('undefined');
  });
});

describe('buildOutboundMessages', () => {
  const turns = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'plan the work' },
  ];
  const leaf = (over: Partial<Leaf> = {}): Leaf => ({
    id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Add rate limiting',
    column: 'todo', status: 'pending', depth: 0, blocking: true,
    createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', ...over,
  });

  /** The bug this file exists to prevent: a second system message is a hard TemplateError. */
  const systemCount = (msgs: { role: string }[]) => msgs.filter((m) => m.role === 'system').length;

  it('folds the branch summary INTO the system message rather than adding a second one', () => {
    const out = buildOutboundMessages({ messages: turns, lastIndex: 2, prompt: 'PROMPT', leaves: [leaf()] });
    expect(systemCount(out)).toBe(1);
    expect(out[0]!.role).toBe('system');
    expect(out[0]!.content).toContain('PROMPT');
    expect(out[0]!.content).toContain('Add rate limiting');
  });

  it('keeps exactly one leading system message on the explicit /plan path too', () => {
    const out = buildOutboundMessages({
      messages: turns, lastIndex: 2, prompt: 'PROMPT', leaves: [leaf()], planText: 'do the thing',
    });
    expect(systemCount(out)).toBe(1);
    expect(out[0]!.role).toBe('system');
    expect(out.at(-1)!.content).toBe('do the thing');
  });

  it('substitutes a placeholder for a bare /plan, so the last message is never empty', () => {
    const out = buildOutboundMessages({ messages: turns, lastIndex: 2, prompt: 'P', leaves: [], planText: '' });
    expect(out.at(-1)!.content).toBe('Propose the work we have been discussing.');
  });

  it('sends no system message in chat mode', () => {
    const out = buildOutboundMessages({ messages: turns, lastIndex: 2, leaves: [leaf()] });
    expect(out).toEqual(turns);
  });

  it('omits the summary when the branch is empty, so a fresh chat carries no dead weight', () => {
    const out = buildOutboundMessages({ messages: turns, lastIndex: 2, prompt: 'PROMPT', leaves: [] });
    expect(out[0]!.content).toBe('PROMPT');
  });

  it('does not lose the turn when lastIndex points past the end', () => {
    const out = buildOutboundMessages({ messages: turns, lastIndex: 9, prompt: 'P', leaves: [], planText: 'x' });
    expect(systemCount(out)).toBe(1);
    expect(out.slice(1)).toEqual(turns);
  });
});
