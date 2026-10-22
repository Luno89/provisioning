import { describe, it, expect } from 'vitest';
import { chatFraming, heardAs, openTurn, peopleIn, personMessage, postedNotToYou, titleFrom } from './conversations.js';

describe('naming a thread', () => {
  it('uses the first thing the user said', () => {
    expect(titleFrom('  help me build a\n  weather service ')).toBe('help me build a weather service');
  });

  it('never returns a blank row', () => {
    expect(titleFrom('')).toBe('New conversation');
    expect(titleFrom('   ')).toBe('New conversation');
  });

  it('truncates rather than storing an essay', () => {
    expect(titleFrom('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe('who said what in a conversation', () => {
  it('records the person on what they ask and the agent on what it answers', async () => {
    const { openTurn, closeTurn } = await import('./conversations.js');
    const opened = openTurn(undefined, { ownerId: 'bo', conversationId: 'c1', runId: 'r1', message: 'hi', now: 't' });
    expect(opened.messages[0]).toMatchObject({ role: 'user', author: { kind: 'person', id: 'bo' } });
    expect(closeTurn(opened, 'r1', { author: { kind: 'agent', slug: 'koala' }, content: 'hello', at: 't' }, 't').messages[1]).toMatchObject({ role: 'assistant', author: { kind: 'agent', slug: 'koala' } });
  });

  it('knows when a message calls Koala in', async () => {
    const { mentionsKoala, personMessage } = await import('./conversations.js');
    expect(mentionsKoala('@koala how is it going?')).toBe(true);
    expect(mentionsKoala('hey @Koala')).toBe(true);
    expect(mentionsKoala('the koala is cute')).toBe(false);
    expect(mentionsKoala('mail me@koala.dev')).toBe(false);
    expect(personMessage('bo', '', 't')).toEqual({ problem: 'the message is empty' });
  });
});

describe('saying who is talking, and to whom', () => {
  const note = { role: 'user' as const, author: { kind: 'person' as const, id: 'p1' }, content: 'ship it friday' };

  it('marks a channel post nobody asked Koala about, and names whoever wrote it', () => {
    expect(heardAs(note, 'channel', { p1: 'bo@example.com' })).toBe(`${postedNotToYou('bo@example.com')}ship it friday`);
    expect(heardAs({ ...note, runId: 'r' }, 'channel', { p1: 'bo@example.com' })).toBe('bo@example.com: ship it friday');
    expect(heardAs(note, 'item', {})).toBe('Someone: ship it friday');
  });

  it('leaves a plain chat, Koala\'s own words and notices as they were', () => {
    expect(heardAs(note, undefined, { p1: 'bo@example.com' })).toBe('ship it friday');
    expect(heardAs({ role: 'assistant', content: 'done', runId: 'r' }, 'channel', {})).toBe('done');
    expect(heardAs({ role: 'notice', author: { kind: 'platform' }, content: 'live' }, 'channel', {})).toBe('live');
  });

  it('lists each person once', () => {
    expect(peopleIn([note, { author: { kind: 'platform' } }, note, { author: { kind: 'person', id: 'p2' } }, {}])).toEqual(['p1', 'p2']);
  });

  it('tells Koala which chat it is in and who is asking', () => {
    const channel = chatFraming({ kind: 'channel' }, 'bo@example.com')!;
    expect(channel).toContain('This is the project\'s channel');
    expect(channel).toContain('"<who> posted, not to you:"');
    expect(channel).toContain('do not act on them unless you are asked to');
    expect(channel).toContain('bo@example.com is asking you now.');
    expect(chatFraming({ kind: 'item', item: 'feature' }, 'bo@example.com')).toBe('This is the chat about the feature below. Every message here is to you; each says who wrote it. bo@example.com is talking with you now.');
    expect(chatFraming({ kind: undefined }, 'bo@example.com')).toBeUndefined();
  });
});

describe('a person\'s message with files attached', () => {
  it('keeps them on the message, and the model hears where they are in every later turn', () => {
    const attachments = [{ name: 'x.png', path: 'chats/c1/x.png' }];
    const opened = openTurn(undefined, { ownerId: 'bo', conversationId: 'c1', runId: 'r1', message: 'look', now: 't', attachments });
    expect(opened.messages[0]).toMatchObject({ content: 'look', attachments });
    expect(heardAs(opened.messages[0]!, undefined, {})).toBe('look\n\nAttached to this message (read each with read_stored_file, naming the project and the path):\n- x.png, in the person\'s own files at chats/c1/x.png');
  });

  it('may be all a channel post is', () => {
    expect(personMessage('bo', '  ', 't', [{ name: 'x.png', path: 'x.png' }])).toMatchObject({ content: '', attachments: [{ name: 'x.png', path: 'x.png' }] });
    expect(personMessage('bo', '  ', 't')).toEqual({ problem: 'the message is empty' });
  });
});
