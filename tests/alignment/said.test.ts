import { describe, expect, it } from 'vitest';
import { excerpt, matching, saidOnLine, withoutRepeats, type Said } from './said.js';

const AT = '2026-11-06T05:19:39.000Z';
const line = (record: Record<string, unknown>): string => JSON.stringify({ timestamp: AT, ...record });
const typed = (content: unknown, extra: Record<string, unknown> = {}): string =>
  line({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content }, ...extra });
const said = (text: string, extra: Partial<Said> = {}): Said => ({ at: AT, session: 's1', how: 'typed', text, ...extra });

describe('what the owner said, read from one transcript line', () => {
  it('takes a typed message as the owner\'s words', () => {
    expect(saidOnLine(typed('users who don\'t need gpu workflows might pick k3d'), 's1')).toEqual([said('users who don\'t need gpu workflows might pick k3d')]);
  });

  it('takes the text parts of a message and leaves the harness\'s reminders out', () => {
    const content = [{ type: 'text', text: '<system-reminder>\nmemory index\n</system-reminder>' }, { type: 'text', text: 'yes fix the tsconfig' }];
    expect(saidOnLine(typed(content), 's1')).toEqual([said('yes fix the tsconfig')]);
  });

  it('takes nothing from a line that is only a command the owner ran', () => {
    expect(saidOnLine(typed('<command-name>/restart</command-name>\n<command-message>restart</command-message>\n<command-args></command-args>'), 's1')).toEqual([]);
  });

  it('marks an accepted suggestion and a queued message for what they are', () => {
    expect(saidOnLine(typed('yeah go with that design', { promptSource: 'suggestion_accepted' }), 's1')).toEqual([said('yeah go with that design', { how: 'suggestion' })]);
    expect(saidOnLine(typed('not me, the user', { promptSource: 'queued' }), 's1')).toEqual([said('not me, the user', { how: 'while-working' })]);
  });

  it('takes a message sent while work ran, as the harness attaches it', () => {
    const attached = line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'as just one example', origin: { kind: 'human' } } });
    expect(saidOnLine(attached, 's1')).toEqual([said('as just one example', { how: 'while-working' })]);
  });

  it('takes a message relayed to a sub-agent, without the relay\'s own words, and names the agent', () => {
    const relayed = typed('The user sent a new message while you were working:\n2 - own label and status\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn.', { isMeta: true });
    expect(saidOnLine(relayed, 's1', 'agent-ae9b')).toEqual([said('2 - own label and status', { how: 'while-working', agent: 'agent-ae9b' })]);
  });

  it('takes nothing the harness wrote: summaries, meta lines and task notifications', () => {
    expect(saidOnLine(line({ type: 'user', isCompactSummary: true, origin: { kind: 'human' }, message: { content: 'This session is being continued' } }), 's1')).toEqual([]);
    expect(saidOnLine(line({ type: 'user', isMeta: true, message: { content: 'Caveat: the messages below' } }), 's1')).toEqual([]);
    expect(saidOnLine(line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '"kind":"human" appears in this text' } }), 's1')).toEqual([]);
  });

  it('takes each answer to a question, with the question and any note', () => {
    const answered = line({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'Your questions have been answered' }] },
      toolUseResult: {
        questions: [],
        answers: { 'Who picks?': 'The person picks', 'Mac?': 'k3d' },
        annotations: { 'Mac?': { notes: 'after v1' } },
      },
    });
    expect(saidOnLine(answered, 's1')).toEqual([
      said('The person picks', { how: 'answer', question: 'Who picks?' }),
      said('k3d (note: after v1)', { how: 'answer', question: 'Mac?' }),
    ]);
  });

  it('takes what the owner said when turning an action down, but not the clarify template', () => {
    const refusal = (text: string): string => line({ type: 'user', message: { content: [{ type: 'tool_result', content: `The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\n${text}` }] } });
    expect(saidOnLine(refusal('don\'t push, ship with --no-push'), 's1')).toEqual([said('don\'t push, ship with --no-push', { how: 'refusal' })]);
    expect(saidOnLine(refusal('The user wants to clarify these questions.\n    This means they may have additional information'), 's1')).toEqual([]);
  });

  it('takes nothing from Koala\'s own replies, even when they quote the owner', () => {
    expect(saidOnLine(line({ type: 'assistant', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'You said "kind":"human"' }] } }), 's1')).toEqual([]);
  });
});

describe('searching what was said', () => {
  it('keeps one copy of a message the transcript records twice within a minute', () => {
    const twice = [said('not me, the user'), said('not me, the user', { at: '2026-11-06T05:20:10.000Z', how: 'while-working' }), said('not me, the user', { at: '2026-11-07T05:19:39.000Z' })];
    expect(withoutRepeats(twice)).toEqual([twice[0], twice[2]]);
  });

  it('finds messages holding every word, in any case, in the text or the question asked', () => {
    const all = [said('users who don\'t need GPU workflows might pick k3d'), said('Drop them', { how: 'answer', question: 'Koala\'s k3d test clusters?' }), said('we need the gpu passthrough')];
    expect(matching(all, ['k3d'])).toEqual([all[0], all[1]]);
    expect(matching(all, ['gpu', 'K3D'])).toEqual([all[0]]);
  });

  it('finds only messages from the day given on', () => {
    const all = [said('k3d', { at: '2026-11-04T03:51:00.000Z' }), said('k3d', { at: '2026-11-06T05:19:39.000Z' })];
    expect(matching(all, ['k3d'], '2026-11-05')).toEqual([all[1]]);
  });

  it('shows a long message around the first word found', () => {
    const text = `${'a'.repeat(300)} k3d ${'b'.repeat(300)}`;
    const shown = excerpt(text, ['k3d'], 100);
    expect(shown).toContain('k3d');
    expect(shown.startsWith('…') && shown.endsWith('…')).toBe(true);
    expect(excerpt('short and whole', ['missing'], 100)).toBe('short and whole');
  });
});
