import { describe, expect, it } from 'vitest';
import { madeHere } from './made-here.js';

interface Chat { id: string; updatedAt: string }

function owner(chats: Chat[]) {
  const store = new Map(chats.map((chat) => [chat.id, { ...chat }]));
  return {
    store,
    kind: madeHere<Chat>({ name: 'conversations', list: async () => [...store.values()], idOf: (chat) => chat.id, stampOf: (chat) => chat.updatedAt }),
    remove: async (id: string) => { store.delete(id); },
  };
}

describe('what a live suite made on the owner\'s own Koala', () => {
  it('removes only what it recorded as made, and finds everything there before untouched', async () => {
    const { store, kind, remove } = owner([{ id: 'channel', updatedAt: 'a' }, { id: 'notes', updatedAt: 'b' }]);
    await kind.before();
    store.set('suite-chat', { id: 'suite-chat', updatedAt: 'c' });
    kind.made('suite-chat');
    expect(kind.madeIds()).toEqual(['suite-chat']);
    await kind.removeMade(remove);
    expect([...store.keys()]).toEqual(['channel', 'notes']);
    await expect(kind.untouched()).resolves.toBeUndefined();
  });

  it('refuses to take as its own anything that was there before it began', async () => {
    const { kind } = owner([{ id: 'channel', updatedAt: 'a' }]);
    await kind.before();
    expect(() => kind.made('channel')).toThrow('conversations channel was there before this suite began, so it is not the suite\'s to remove');
  });

  it('says which of the owner\'s things went or changed while it ran', async () => {
    const { store, kind } = owner([{ id: 'channel', updatedAt: 'a' }, { id: 'notes', updatedAt: 'b' }]);
    await kind.before();
    store.delete('channel');
    store.set('notes', { id: 'notes', updatedAt: 'later' });
    await expect(kind.untouched()).rejects.toThrow('of the owner\'s conversations, channel is gone and notes changed while the suite ran');
  });

  it('is told what was there before it records or removes anything', async () => {
    const { kind, remove } = owner([]);
    expect(() => kind.made('x')).toThrow('conversations: read what was there before recording what the suite made');
    await expect(kind.removeMade(remove)).rejects.toThrow('conversations: read what was there before removing anything');
  });
});
