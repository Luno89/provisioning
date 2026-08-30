import { describe, it, expect } from 'vitest';
import { needsHandoff, historyForPrompt, buildHandoffNotice, withHandoff, trimKoalaThread } from './koala-context.js';

import type { Conversation, ConversationMessage } from './conversations.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

const msg = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  role: 'user', content: 'something', at: '2026-08-20T00:00:00.000Z', ...over,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', ownerId: 'u1', title: 'Ship the thing', messages: [],
  createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  ...over,
});

describe('deciding when a conversation has outgrown the window', () => {
  it('leaves a short conversation alone', () => {
    expect(needsHandoff(BUDGET, 4_000, 100)).toBe(false);
  });

  it('fires before the window is full, not when it is', () => {
    const atThreshold = BUDGET.handoff.at * BUDGET.contextTokens * 4;
    expect(needsHandoff(BUDGET, atThreshold, 0)).toBe(true);
    expect(BUDGET.handoff.at).toBeLessThan(0.7);
  });

  it('counts the message about to be appended', () => {
    const justUnder = (BUDGET.handoff.at * BUDGET.contextTokens * 4) - 8_000;
    expect(needsHandoff(BUDGET, justUnder, 0)).toBe(false);
    expect(needsHandoff(BUDGET, justUnder, 12_000)).toBe(true);
  });
});

describe('what a prompt carries after a reset', () => {
  it('is the whole thread when there has never been one', () => {
    const messages = [msg(), msg({ role: 'assistant' }), msg()];
    expect(historyForPrompt(messages)).toHaveLength(3);
  });

  it('starts AT the notice, not after it', () => {
    const messages = [msg(), msg(), msg({ role: 'assistant', notice: true, handoff: true }), msg()];
    const out = historyForPrompt(messages);
    expect(out).toHaveLength(2);
    expect(out[0]?.handoff).toBe(true);
  });

  it('reads from the most recent boundary when there have been several', () => {
    const messages = [
      msg(), msg({ role: 'assistant', notice: true, handoff: true }), msg(),
      msg({ role: 'assistant', notice: true, handoff: true }), msg(),
    ];
    expect(historyForPrompt(messages)).toHaveLength(2);
  });

  it('is not truncated by a notice that is not a boundary', () => {
    const messages = [msg(), msg({ role: 'assistant', notice: true }), msg()];
    expect(historyForPrompt(messages)).toHaveLength(3);
  });
});

describe('what survives into the artifact', () => {
  it('carries the goal from the first thing the user asked', () => {
    const c = conv({ messages: [msg({ content: 'Build me an invoicing service' }), msg({ role: 'assistant' })] });
    expect(buildHandoffNotice(BUDGET, c).content).toContain('Build me an invoicing service');
  });

  it('separates proposals still waiting from ones already accepted', () => {
    const c = conv({
      messages: [msg()],
      proposedTrees: [
        { id: 'p1', name: 'Invoicer', type: 'api-service', goal: 'bill people', proposedAt: 'x' },
        { id: 'p2', name: 'Dashboard', type: 'web-app', goal: 'show it', proposedAt: 'x', treeId: 'tree-9' },
      ],
    });
    const body = buildHandoffNotice(BUDGET, c).content;

    expect(body).toContain('Invoicer');
    expect(body).toContain('Dashboard');
    expect(body).toContain('do not propose these again');
  });

  it('carries what the tools found, and drops what failed', () => {
    const c = conv({
      messages: [
        msg(),
        msg({
          role: 'assistant',
          toolCalls: [
            { id: '1', name: 'get_logs', args: '{}', ok: true, digest: 'CrashLoopBackOff: no space left on device' },
            { id: '2', name: 'list_trees', args: '{}', ok: false, digest: '{"error":"nope"}' },
          ],
        }),
      ],
    });
    const body = buildHandoffNotice(BUDGET, c).content;

    expect(body).toContain('no space left on device');
    expect(body).not.toContain('list_trees');
  });

  it('does not duplicate the enabled-services catalogue', () => {
    const c = conv({ messages: [msg()], sessionId: 's1', enabledMcp: ['github-mcp'] });
    expect(buildHandoffNotice(BUDGET, c).content).not.toContain('github-mcp');
  });

  it('is a notice AND a boundary, so it renders inline and truncates the next prompt', () => {
    const notice = buildHandoffNotice(BUDGET, conv({ messages: [msg()] }));
    expect(notice.notice).toBe(true);
    expect(notice.handoff).toBe(true);
    expect(notice.role).toBe('assistant');
  });
});

describe('applying the reset', () => {
  it('keeps the live tail verbatim behind the notice', () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg({ content: `turn ${i}` }));
    const out = withHandoff(BUDGET, conv({ messages }));

    expect(out[0]?.handoff).toBe(true);
    expect(out).toHaveLength(1 + BUDGET.handoff.tail);
    expect(out[out.length - 1]?.content).toBe('turn 19');
  });

  it('does not nest artifacts when it fires twice', () => {
    const first = withHandoff(BUDGET, conv({ messages: Array.from({ length: 20 }, (_, i) => msg({ content: `a${i}` })) }));
    const grown = [...first, ...Array.from({ length: 20 }, (_, i) => msg({ content: `b${i}` }))];
    const second = withHandoff(BUDGET, conv({ messages: grown }));

    expect(second.filter((m) => m.handoff)).toHaveLength(1);
    expect(second[0]?.handoff).toBe(true);
  });
});

describe('capping the stored thread', () => {
  it('strips reasoning from older messages and keeps it on recent ones', () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg({ content: `m${i}`, reasoning: 'x'.repeat(500) }));
    const out = trimKoalaThread(BUDGET, messages);

    expect(out[0]?.reasoning).toBeUndefined();
    expect(out[out.length - 1]?.reasoning).toBeDefined();
    expect(out.filter((m) => m.reasoning)).toHaveLength(BUDGET.handoff.reasoningKept);
    expect(out.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it('leaves a short thread completely alone', () => {
    const messages = [msg({ reasoning: 'think' }), msg({ reasoning: 'more' })];
    expect(trimKoalaThread(BUDGET, messages)).toEqual(messages);
  });
});
