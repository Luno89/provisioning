import { describe, expect, it } from 'vitest';
import { chatFolder, cleanPath, inside, outside, storedPlaceOf, storyFolder } from './file-places.js';

describe('where a scope\'s files are kept', () => {
  it('keeps a project\'s files in the project, a person\'s own in theirs, and a chat\'s in the chat unless it belongs to a project', () => {
    expect(storedPlaceOf('u1', { kind: 'project', project: { id: 'p1' } })).toEqual({ scope: { kind: 'project', id: 'p1' }, under: '' });
    expect(storedPlaceOf('u1', { kind: 'person' })).toEqual({ scope: { kind: 'person', id: 'u1' }, under: '' });
    expect(storedPlaceOf('u1', { kind: 'conversation', conversationId: 'c1' })).toEqual({ scope: { kind: 'conversation', id: 'c1' }, under: '' });
  });

  it('keeps a chat bound to a project in that project\'s files, under the chat\'s own folder', () => {
    expect(storedPlaceOf('u1', { kind: 'conversation', conversationId: 'channel-p1', projectId: 'p1' })).toEqual({ scope: { kind: 'project', id: 'p1' }, under: 'chats/channel-p1' });
    expect(chatFolder('story-l1')).toBe('chats/story-l1');
    expect(storyFolder('l1')).toBe('stories/l1');
  });

  it('puts a path under a folder and takes it back out, refusing one from outside it', () => {
    expect(inside('', 'a.pdf')).toBe('a.pdf');
    expect(inside('chats/c1', 'a.pdf')).toBe('chats/c1/a.pdf');
    expect(inside('chats/c1', '')).toBe('chats/c1');
    expect(outside('', 'docs/a.pdf')).toBe('docs/a.pdf');
    expect(outside('chats/c1', 'chats/c1/docs/a.pdf')).toBe('docs/a.pdf');
    expect(outside('chats/c1', 'chats/c1')).toBe('');
    expect(outside('chats/c1', 'chats/c10/a.pdf')).toBeUndefined();
    expect(outside('chats/c1', 'a.pdf')).toBeUndefined();
  });
});

describe('paths in a project\'s files', () => {
  it('are cleaned and kept inside', () => {
    expect(cleanPath('/docs//./spec.pdf')).toEqual({ ok: true, path: 'docs/spec.pdf' });
    expect(cleanPath('docs/../../etc')).toMatchObject({ ok: false });
    expect(cleanPath('')).toEqual({ ok: false, why: 'a file needs a name' });
    expect(cleanPath('', { allowRoot: true })).toEqual({ ok: true, path: '' });
    expect(cleanPath('a\\b')).toMatchObject({ ok: false });
  });
});
