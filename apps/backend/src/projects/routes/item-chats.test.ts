import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { ChatItem, Conversation } from '../../engine/index.js';
import { CALLER, post } from '../testing/route-call.js';
import type { ItemChatService } from '../services/ItemChatService.js';
import { itemChatsRouter } from './item-chats.js';

const chat = (id: string, title: string): Conversation => ({ id, ownerId: CALLER.id, title, kind: 'item', messages: [], createdAt: 't', updatedAt: 't' });

function setUp() {
  const items = mock<ItemChatService>();
  return { items, router: itemChatsRouter({ items }) };
}

describe('opening the chat of a story or a feature', () => {
  it('asks for a story\'s chat by its leaf and answers the chat\'s id and title', async () => {
    const { items, router } = setUp();
    items.ensure.calledWith(CALLER.id, matches<ChatItem>((item) => item.kind === 'story' && item.leafId === 'l1')).mockResolvedValue(chat('story-l1', 'Checkout'));
    expect(await post(router, '/story/l1/chat')).toEqual({ status: 200, body: { id: 'story-l1', title: 'Checkout' } });
  });

  it('asks for a feature\'s chat by its branch', async () => {
    const { items, router } = setUp();
    items.ensure.calledWith(CALLER.id, matches<ChatItem>((item) => item.kind === 'feature' && item.branchId === 'b1')).mockResolvedValue(chat('feature-b1', 'Payments'));
    expect(await post(router, '/feature/b1/chat')).toEqual({ status: 200, body: { id: 'feature-b1', title: 'Payments' } });
  });

  it('refuses any other kind of item without asking the service', async () => {
    const { items, router } = setUp();
    expect(await post(router, '/epic/t1/chat')).toEqual({ status: 404, body: { error: 'Only a story or a feature has its own chat' } });
    expect(items.ensure).not.toHaveBeenCalled();
  });

  it('answers 404 naming the kind when the person has no such item', async () => {
    const { items, router } = setUp();
    items.ensure.mockResolvedValue(undefined);
    expect(await post(router, '/story/nope/chat')).toEqual({ status: 404, body: { error: 'No such story' } });
    expect(await post(router, '/feature/nope/chat')).toEqual({ status: 404, body: { error: 'No such feature' } });
  });
});
