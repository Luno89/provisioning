import { describe, it, expect } from 'vitest';
import { buildSiblingContext, MAX_SIBLING_LEAVES, buildLeafContext, MAX_CONTEXT_LEAVES , buildOutboundMessages } from './leaf-context.js';
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

describe('a persona in the system message', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  it('never produces a second system message, whatever else is set', () => {
    // The invariant this whole function exists for. Chat templates reject more than one system
    // message outright — TemplateError, total failure, not degradation — and it has broken twice.
    const out = buildOutboundMessages({
      messages, lastIndex: 0,
      personaPrompt: 'You are a reviewer.',
      prompt: 'PLAN MODE',
      toolPrompt: 'TOOL DISCIPLINE',
      leaves: [],
    });

    expect(out.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(out[0]!.role).toBe('system');
  });

  it('puts identity before instructions', () => {
    // Who is answering, then what this turn is for. A persona buried under the mode prompt reads
    // as an afterthought to the model too.
    const out = buildOutboundMessages({
      messages, lastIndex: 0, personaPrompt: 'IDENTITY', prompt: 'MODE', leaves: [],
    });

    const content = String(out[0]!.content);
    expect(content.indexOf('IDENTITY')).toBeLessThan(content.indexOf('MODE'));
  });

  it('gives chat mode a system message it would not otherwise have', () => {
    // Chat sends none by default so conversation is not biased toward finding work. Choosing a
    // persona is an explicit request to be answered by someone in particular, so it overrides that.
    const withPersona = buildOutboundMessages({
      messages, lastIndex: 0, personaPrompt: 'You are terse.', leaves: [],
    });
    const without = buildOutboundMessages({ messages, lastIndex: 0, leaves: [] });

    expect(withPersona[0]!.role).toBe('system');
    expect(without).toEqual(messages);
  });
});


describe('what the rest of the project has already built', () => {
  /**
   * ── THE FAILURE THIS PREVENTS ──
   * The context stopped at the branch, so a second conversation about the same project began blind
   * to every leaf the first one had finished. Measured on this instance: one tree held 26 leaves
   * across three conversations and 6.6M tokens of completed work that a new conversation could not
   * see and had no reason not to build again.
   */
  const sibling = (over: Partial<Leaf>) => leaf({ branchId: 'b2', ...over });

  it('is empty when the project has no other conversations', () => {
    // A first conversation, or an unfiled one, must carry no dead weight.
    expect(buildSiblingContext([])).toBe('');
  });

  it('lists finished work so it is not built twice', () => {
    const ctx = buildSiblingContext([sibling({ title: 'Add the HTTP client', status: 'succeeded' })]);
    expect(ctx).toContain('Add the HTTP client');
    expect(ctx).toContain('done');
    expect(ctx).toMatch(/do not propose building it again/i);
  });

  it('does NOT list an unaccepted proposal from another conversation', () => {
    /**
     * The one that would cause harm in the opposite direction. A proposal is not work that exists;
     * listing it as though it were would tell the model the job is handled and stop the very work
     * the proposal was asking for — a deadlock nobody would think to look for.
     */
    expect(buildSiblingContext([sibling({ title: 'Not agreed yet', status: 'proposed' })])).toBe('');
  });

  it('does not list cancelled work, which is available again', () => {
    // Somebody deliberately stopped it. Treating that as done makes the decision irreversible.
    expect(buildSiblingContext([sibling({ title: 'Abandoned', status: 'cancelled' })])).toBe('');
  });

  it('lists failed work AND marks it as failed', () => {
    /**
     * Failed work may well deserve another attempt, so it must not read as done — but proposing it
     * as though it were a fresh idea hides that it has already been tried once.
     */
    const ctx = buildSiblingContext([sibling({ title: 'Flaky thing', status: 'failed' })]);
    expect(ctx).toContain('Flaky thing');
    expect(ctx).toContain('failed');
    expect(ctx).toMatch(/say so explicitly rather than proposing it as new/i);
  });

  it('puts finished work first, because that is the list that must not be repeated', () => {
    const ctx = buildSiblingContext([
      sibling({ id: 'a', title: 'Tried and failed', status: 'failed' }),
      sibling({ id: 'b', title: 'Actually done', status: 'succeeded' }),
    ]);
    expect(ctx.indexOf('Actually done')).toBeLessThan(ctx.indexOf('Tried and failed'));
  });

  it('caps the list and says how much it left out', () => {
    // Silently truncating would have the model believe the project is smaller than it is.
    const many = Array.from({ length: MAX_SIBLING_LEAVES + 5 }, (_, i) =>
      sibling({ id: `s${i}`, title: `Thing ${i}`, status: 'succeeded' }));
    expect(buildSiblingContext(many)).toContain('…and 5 more');
  });
});

describe('the two lists reaching the model', () => {
  it('keeps this conversation apart from the rest of the project', () => {
    /**
     * They say different things — one is what this conversation has going on, the other is what it
     * must not rebuild — and merging them would make the model treat another conversation's work as
     * its own to continue.
     */
    const out = buildOutboundMessages({
      messages: [{ role: 'user', content: 'hi' }],
      lastIndex: 0,
      prompt: 'PLAN',
      leaves: [leaf({ title: 'Mine', status: 'running' })],
      siblingLeaves: [leaf({ id: 'x', branchId: 'b2', title: 'Theirs', status: 'succeeded' })],
    });
    const system = String(out[0]!.content);
    expect(system).toContain('Work already tracked on this branch:');
    expect(system).toContain('Mine');
    expect(system).toContain('Work in this project, from OTHER conversations:');
    expect(system).toContain('Theirs');
    // Still exactly one system message, and first — chat templates reject anything else outright.
    expect(out.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(out[0]!.role).toBe('system');
  });

  it('adds nothing when there are no sibling conversations', () => {
    const out = buildOutboundMessages({
      messages: [{ role: 'user', content: 'hi' }],
      lastIndex: 0,
      prompt: 'PLAN',
      leaves: [leaf({ title: 'Mine' })],
    });
    expect(String(out[0]!.content)).not.toContain('OTHER conversations');
  });
});
