import { describe, it, expect } from 'vitest';
import {
  needsHandoff, historyForPrompt, buildHandoffNotice, withHandoff, trimKoalaThread,
  KOALA_CONTEXT_PRESSURE, KOALA_HANDOFF_TAIL, KOALA_REASONING_KEPT,
} from './koala-context.js';
import { FALLBACK_CONTEXT_TOKENS } from './sampling.js';
import type { Conversation, ConversationMessage } from './conversations.js';

const msg = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  role: 'user', content: 'something', at: '2026-08-20T00:00:00.000Z', ...over,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', ownerId: 'u1', title: 'Ship the thing', messages: [],
  createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  ...over,
});

/**
 * The whole point of the module: the chat sent every message forever, and `fittedMaxTokens` floors,
 * so the prompt silently passed the window and the engine refused the request outright.
 */
describe('deciding when a conversation has outgrown the window', () => {
  it('leaves a short conversation alone', () => {
    expect(needsHandoff(4_000, 100)).toBe(false);
  });

  it('fires before the window is full, not when it is', () => {
    const atThreshold = KOALA_CONTEXT_PRESSURE * FALLBACK_CONTEXT_TOKENS * 4;
    expect(needsHandoff(atThreshold, 0)).toBe(true);
    // Well clear of the cliff, so the notice and a full reply still fit.
    expect(KOALA_CONTEXT_PRESSURE).toBeLessThan(0.7);
  });

  it('counts the message about to be appended', () => {
    // Just under on its own, over once the incoming message is included. Checking before the
    // append is the only reason this distinction is available at all.
    const justUnder = (KOALA_CONTEXT_PRESSURE * FALLBACK_CONTEXT_TOKENS * 4) - 8_000;
    expect(needsHandoff(justUnder, 0)).toBe(false);
    expect(needsHandoff(justUnder, 12_000)).toBe(true);
  });
});

describe('what a prompt carries after a reset', () => {
  it('is the whole thread when there has never been one', () => {
    const messages = [msg(), msg({ role: 'assistant' }), msg()];
    expect(historyForPrompt(messages)).toHaveLength(3);
  });

  it('starts AT the notice, not after it', () => {
    // The notice is the summary of everything above, so skipping it would discard the very thing
    // the reset produced.
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
    // Round-exhaustion notices are notices but not handoffs. Treating them as boundaries would
    // silently amputate a conversation that was never summarised.
    const messages = [msg(), msg({ role: 'assistant', notice: true }), msg()];
    expect(historyForPrompt(messages)).toHaveLength(3);
  });
});

describe('what survives into the artifact', () => {
  it('carries the goal from the first thing the user asked', () => {
    const c = conv({ messages: [msg({ content: 'Build me an invoicing service' }), msg({ role: 'assistant' })] });
    expect(buildHandoffNotice(c).content).toContain('Build me an invoicing service');
  });

  it('separates proposals still waiting from ones already accepted', () => {
    const c = conv({
      messages: [msg()],
      proposedTrees: [
        { id: 'p1', name: 'Invoicer', type: 'api-service', goal: 'bill people', proposedAt: 'x' },
        { id: 'p2', name: 'Dashboard', type: 'web-app', goal: 'show it', proposedAt: 'x', treeId: 'tree-9' },
      ],
    });
    const body = buildHandoffNotice(c).content;

    // An open proposal is a live offer the user can still accept, so it has to survive.
    expect(body).toContain('Invoicer');
    // An accepted one survives for the opposite reason: so Koala does not offer it a second time.
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
    const body = buildHandoffNotice(c).content;

    expect(body).toContain('no space left on device');
    // A failed call tells a future turn nothing it cannot learn by calling again.
    expect(body).not.toContain('list_trees');
  });

  /**
   * `buildKoalaPrompt` rebuilds the service catalogue from `enabledForSession` on every turn,
   * marking what is already on. Copying it into the artifact would be a second source of truth for
   * a fact that already survives a reset perfectly.
   */
  it('does not duplicate the enabled-services catalogue', () => {
    const c = conv({ messages: [msg()], sessionId: 's1', enabledMcp: ['github-mcp'] });
    expect(buildHandoffNotice(c).content).not.toContain('github-mcp');
  });

  it('is a notice AND a boundary, so it renders inline and truncates the next prompt', () => {
    const notice = buildHandoffNotice(conv({ messages: [msg()] }));
    expect(notice.notice).toBe(true);
    expect(notice.handoff).toBe(true);
    expect(notice.role).toBe('assistant');
  });
});

describe('applying the reset', () => {
  it('keeps the live tail verbatim behind the notice', () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg({ content: `turn ${i}` }));
    const out = withHandoff(conv({ messages }));

    expect(out[0]?.handoff).toBe(true);
    expect(out).toHaveLength(1 + KOALA_HANDOFF_TAIL);
    // The most recent exchange is what the current question depends on, so it is not summarised.
    expect(out[out.length - 1]?.content).toBe('turn 19');
  });

  it('does not nest artifacts when it fires twice', () => {
    const first = withHandoff(conv({ messages: Array.from({ length: 20 }, (_, i) => msg({ content: `a${i}` })) }));
    const grown = [...first, ...Array.from({ length: 20 }, (_, i) => msg({ content: `b${i}` }))];
    const second = withHandoff(conv({ messages: grown }));

    // Exactly one boundary, however many times this runs.
    expect(second.filter((m) => m.handoff)).toHaveLength(1);
    expect(second[0]?.handoff).toBe(true);
  });
});

describe('capping the stored thread', () => {
  /**
   * Separate problem from the prompt: `reasoning` is never sent to the model, but it is stored at
   * up to 20,000 characters a message and shipped to the browser on every conversation GET.
   */
  it('strips reasoning from older messages and keeps it on recent ones', () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg({ content: `m${i}`, reasoning: 'x'.repeat(500) }));
    const out = trimKoalaThread(messages);

    expect(out[0]?.reasoning).toBeUndefined();
    expect(out[out.length - 1]?.reasoning).toBeDefined();
    expect(out.filter((m) => m.reasoning)).toHaveLength(KOALA_REASONING_KEPT);
    // Content is never touched — this caps the document, it does not summarise it.
    expect(out.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it('leaves a short thread completely alone', () => {
    const messages = [msg({ reasoning: 'think' }), msg({ reasoning: 'more' })];
    expect(trimKoalaThread(messages)).toEqual(messages);
  });
});
