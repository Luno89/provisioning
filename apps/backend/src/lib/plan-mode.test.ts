import { describe, it, expect } from 'vitest';
import { extractProposals, stripProposalBlock, parseChatCommand, isChatMode, MAX_PROPOSALS_PER_REPLY } from './plan-mode.js';

/**
 * These cover the shapes models ACTUALLY emit rather than the shape the prompt asks for. A local
 * 27B does not reliably return clean JSON, and every case below is a way the parser could invent
 * work the model did not propose — which is worse than reading nothing, because the proposed
 * status exists precisely so a human reviews before anything runs.
 */
const fenced = (json: string) => '```json\n' + json + '\n```';

describe('extractProposals', () => {
  it('reads a well-formed fenced block', () => {
    const reply = 'Here is what I would do.\n\n' + fenced('{"leaves":[{"title":"Add a rate limit","body":"Token bucket on /api/chat"}]}');
    expect(extractProposals(reply)).toEqual([{ title: 'Add a rate limit', body: 'Token bucket on /api/chat' }]);
  });

  it('proposes NOTHING when the model just talks', () => {
    // The common case, and it must stay empty — otherwise ordinary discussion inside a planning
    // conversation manufactures work nobody asked for.
    expect(extractProposals('That depends on whether you want per-user or global limits. Which?')).toEqual([]);
  });

  it('ignores a fenced code sample that is not a proposal', () => {
    const reply = 'You could write:\n\n```ts\nconst x = 1;\n```\n\nWhat do you think?';
    expect(extractProposals(reply)).toEqual([]);
  });

  it('survives malformed JSON rather than guessing', () => {
    expect(extractProposals(fenced('{"leaves":[{"title":"Broken"'))).toEqual([]);
    expect(extractProposals(fenced('not json at all'))).toEqual([]);
  });

  it('accepts a bare object when the model forgets the fence', () => {
    // Smaller models drop the fence often enough to be worth one attempt.
    expect(extractProposals('Sure: {"leaves":[{"title":"Do the thing"}]}')).toEqual([{ title: 'Do the thing' }]);
  });

  it('handles a block without the json language tag', () => {
    expect(extractProposals('```\n{"leaves":[{"title":"Untagged"}]}\n```')).toEqual([{ title: 'Untagged' }]);
  });

  it('finds the real block when an illustrative one comes first', () => {
    const reply = '```ts\nfoo()\n```\nand then:\n' + fenced('{"leaves":[{"title":"Real work"}]}');
    expect(extractProposals(reply)).toEqual([{ title: 'Real work' }]);
  });

  it('drops a proposal with no title, which would render as an unjudgeable empty leaf', () => {
    expect(extractProposals(fenced('{"leaves":[{"body":"orphan"},{"title":"Kept"}]}'))).toEqual([{ title: 'Kept' }]);
    expect(extractProposals(fenced('{"leaves":[{"title":"   "}]}'))).toEqual([]);
  });

  it('ignores a payload that is not a leaves array', () => {
    expect(extractProposals(fenced('{"leaves":"soon"}'))).toEqual([]);
    expect(extractProposals(fenced('{"tasks":[{"title":"wrong key"}]}'))).toEqual([]);
    expect(extractProposals(fenced('[]'))).toEqual([]);
  });

  it('caps a runaway reply so one turn cannot flood a branch', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `Leaf ${i}` }));
    expect(extractProposals(fenced(JSON.stringify({ leaves: many }))).length).toBe(MAX_PROPOSALS_PER_REPLY);
  });

  it('truncates absurd fields rather than rejecting the proposal', () => {
    const long = 'x'.repeat(10_000);
    const [p] = extractProposals(fenced(JSON.stringify({ leaves: [{ title: long, body: long }] })));
    expect(p!.title.length).toBeLessThanOrEqual(200);
    expect(p!.body!.length).toBeLessThanOrEqual(4000);
  });

  it('handles empty input', () => {
    expect(extractProposals('')).toEqual([]);
    expect(() => extractProposals('```json\n```')).not.toThrow();
  });
});

describe('stripProposalBlock', () => {
  it('removes the proposal block, which is rendered as leaves instead', () => {
    const reply = 'I would start here.\n\n' + fenced('{"leaves":[{"title":"A"}]}');
    expect(stripProposalBlock(reply)).toBe('I would start here.');
  });

  it('leaves ordinary code blocks alone', () => {
    const reply = 'Try:\n```ts\nconst x = 1;\n```';
    expect(stripProposalBlock(reply)).toBe(reply);
  });

  it('leaves a reply with no blocks untouched', () => {
    expect(stripProposalBlock('Just talking.')).toBe('Just talking.');
  });
});

describe('parseChatCommand', () => {
  it('recognises /plan and strips it', () => {
    expect(parseChatCommand('/plan add rate limiting')).toEqual({ command: 'plan', text: 'add rate limiting' });
    expect(parseChatCommand('  /plan   add OAuth  ')).toEqual({ command: 'plan', text: 'add OAuth' });
  });

  it('is case-insensitive', () => {
    expect(parseChatCommand('/PLAN do a thing').command).toBe('plan');
  });

  it('accepts /plan with no text, so it can be used to ask for a plan of what was just discussed', () => {
    expect(parseChatCommand('/plan')).toEqual({ command: 'plan', text: '' });
  });

  it('leaves ordinary messages untouched', () => {
    expect(parseChatCommand('what do you think about rate limiting?')).toEqual({
      command: null, text: 'what do you think about rate limiting?',
    });
  });

  it('does not claim a word that merely starts with plan', () => {
    // "/planning" is not the command, and treating it as one would silently eat the message.
    expect(parseChatCommand('/planning permission').command).toBeNull();
  });

  it('ignores unknown slash commands rather than inventing syntax', () => {
    // Far more likely to be someone typing a path than a command.
    expect(parseChatCommand('/usr/local/bin is on PATH').command).toBeNull();
    expect(parseChatCommand('/deploy now').command).toBeNull();
  });

  it('handles empty and missing input', () => {
    expect(parseChatCommand('')).toEqual({ command: null, text: '' });
    expect(() => parseChatCommand(undefined as any)).not.toThrow();
  });
});

describe('isChatMode', () => {
  it('accepts the three modes', () => {
    for (const m of ['chat', 'auto', 'plan']) expect(isChatMode(m)).toBe(true);
  });

  it('rejects anything else, so the caller can fall back rather than trust it', () => {
    // A chat request must never fail because a selector was out of date, so the route defaults
    // instead of erroring — which only works if this is honest about what it does not recognise.
    for (const v of ['planning', 'PLAN', '', undefined, null, 1, {}]) expect(isChatMode(v)).toBe(false);
  });
});
