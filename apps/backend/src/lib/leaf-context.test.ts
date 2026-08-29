import { describe, it, expect } from 'vitest';
import { buildSiblingContext, MAX_SIBLING_LEAVES, buildLeafContext, MAX_CONTEXT_LEAVES , buildOutboundMessages } from './leaf-context.js';
import type { Branch, Leaf } from './leaves.js';

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
    const ctx = buildLeafContext([leaf({ status: 'running' }), leaf({ id: 'l2', status: 'succeeded' })]);
    expect(ctx).not.toMatch(/Munching|Digested|Sprouting|Bitter/);
  });

  it('tells the model not to repeat existing work', () => {
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
    const out = buildOutboundMessages({
      messages, lastIndex: 0, personaPrompt: 'IDENTITY', prompt: 'MODE', leaves: [],
    });

    const content = String(out[0]!.content);
    expect(content.indexOf('IDENTITY')).toBeLessThan(content.indexOf('MODE'));
  });

  it('gives chat mode a system message it would not otherwise have', () => {
    const withPersona = buildOutboundMessages({
      messages, lastIndex: 0, personaPrompt: 'You are terse.', leaves: [],
    });
    const without = buildOutboundMessages({ messages, lastIndex: 0, leaves: [] });

    expect(withPersona[0]!.role).toBe('system');
    expect(without).toEqual(messages);
  });
});

const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b2', ownerId: 'u1', title: 'Earlier run', messages: [],
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
  ...over,
} as Branch);

describe('where the project stands', () => {
  const sibling = (over: Partial<Leaf>) => leaf({ branchId: 'b2', ...over });

  it('is empty when the project has no other conversations', () => {
    expect(buildSiblingContext([], [])).toBe('');
  });

  it('collapses a finished run to a line and lists what it built', () => {
    const ctx = buildSiblingContext(
      [branch()],
      [sibling({ title: 'Add the HTTP client', status: 'succeeded', verified: true })],
    );
    expect(ctx).toContain('Finished runs in this project:');
    expect(ctx).toContain('Earlier run');
    expect(ctx).toContain('Already built (do not build these again):');
    expect(ctx).toContain('Add the HTTP client');
  });

  it('lifts work that was not delivered into a decision, with its attempt count', () => {
    const ctx = buildSiblingContext([branch()], [sibling({
      title: 'Flaky thing', status: 'failed',
      attempts: [{ attempt: 0, error: 'e', failedAt: '' }, { attempt: 1, error: 'e', failedAt: '' }],
    })]);
    expect(ctx).toContain('Attempted in this project and NOT delivered:');
    expect(ctx).toContain('Flaky thing');
    expect(ctx).toContain('2 attempts');
    expect(ctx).toContain('Earlier run');
    expect(ctx).toMatch(/say that it is a retry/i);
    expect(ctx).not.toMatch(/Already built[\s\S]*Flaky thing/);
  });

  it('describes a conversation still in flight leaf by leaf', () => {
    const ctx = buildSiblingContext([branch({ title: 'Live run' })], [
      sibling({ id: 'a', title: 'Being built now', status: 'running' }),
    ]);
    expect(ctx).toContain('Being worked on right now, in another conversation:');
    expect(ctx).toContain('Being built now');
    expect(ctx).toContain('Live run');
    expect(ctx).toMatch(/Do not start any of these/i);
    expect(ctx).not.toContain('Finished runs in this project:');
  });

  it('does NOT present an unaccepted proposal as existing work', () => {
    const ctx = buildSiblingContext([branch()], [sibling({ title: 'Not agreed yet', status: 'proposed' })]);
    expect(ctx).not.toContain('Already built');
    expect(ctx).not.toContain('Finished runs');
  });

  it('does not owe anything for work that was cancelled', () => {
    const ctx = buildSiblingContext([branch()], [sibling({ title: 'Abandoned', status: 'cancelled' })]);
    expect(ctx).not.toContain('NOT delivered');
    expect(ctx).not.toContain('Abandoned');
  });

  it('treats an unchecked claim as built rather than owed', () => {
    const ctx = buildSiblingContext([branch()], [sibling({ title: 'Probably fine', status: 'succeeded', verified: false })]);
    expect(ctx).toMatch(/Already built[\s\S]*Probably fine/);
    expect(ctx).not.toContain('NOT delivered');
  });

  it('caps the built list and counts what it left out', () => {
    const many = Array.from({ length: MAX_SIBLING_LEAVES + 5 }, (_, i) =>
      sibling({ id: `s${i}`, title: `Thing ${i}`, status: 'succeeded', verified: true }));
    expect(buildSiblingContext([branch()], many)).toContain('…and 5 more');
  });
});

describe('the two lists reaching the model', () => {
  it('keeps this conversation apart from the rest of the project', () => {
    const out = buildOutboundMessages({
      messages: [{ role: 'user', content: 'hi' }],
      lastIndex: 0,
      prompt: 'PLAN',
      leaves: [leaf({ title: 'Mine', status: 'running' })],
      siblingLeaves: [leaf({ id: 'x', branchId: 'b2', title: 'Theirs', status: 'succeeded' })],
      siblingBranches: [branch()],
    });
    const system = String(out[0]!.content);
    expect(system).toContain('Work already tracked on this branch:');
    expect(system).toContain('Mine');
    expect(system).toContain('Already built (do not build these again):');
    expect(system).toContain('Theirs');
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
    expect(String(out[0]!.content)).not.toContain('Already built');
    expect(String(out[0]!.content)).not.toContain('Finished runs');
  });
});

describe('buildOutboundMessages — file conventions', () => {
  const turns = [{ role: 'user', content: 'plan the work' }];
  const build = (over: Record<string, unknown> = {}) => buildOutboundMessages({
    messages: turns as never, lastIndex: 0, leaves: [], ...over,
  } as never);

  it('puts the conventions in the system message where the planner will read them', () => {
    const out = build({ fileConventions: 'This is a node project. Source files end in .js.' });
    expect(out[0]?.role).toBe('system');
    expect(String(out[0]?.content)).toContain('Source files end in .js');
  });

  it('composes them alongside doneMeans rather than replacing it', () => {
    const out = build({
      doneMeans: 'service whose tests pass',
      fileConventions: 'This is a node project. Source files end in .js.',
    });
    const system = String(out[0]?.content);
    expect(system).toContain('service whose tests pass');
    expect(system).toContain('.js');
  });

  it('brings a system message into being on its own, so a bare planning turn still gets them', () => {
    const out = build({ fileConventions: 'This is a python project. Source files end in .py.' });
    expect(out[0]?.role).toBe('system');
  });

  it('adds nothing when the tree type ships no scaffold and states no language', () => {
    const out = build({});
    expect(out[0]?.role).not.toBe('system');
  });
});
