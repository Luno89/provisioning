import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { ChatItem, Conversation } from '../../engine/index.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import type { ItemChatService } from '../services/ItemChatService.js';
import { itemChatsRouter } from './item-chats.js';

const chat = (id: string, title: string): Conversation => ({ id, ownerId: TEST_USER.id, title, kind: 'item', messages: [], createdAt: 't', updatedAt: 't' });

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp() {
  const items = mock<ItemChatService>();
  const routes = await routesInProcess({ prefix: '/', router: () => itemChatsRouter({ items }) });
  return { items, routes };
}

describe('opening the chat of a story or a feature', () => {
  it('asks for a story\'s chat by its leaf and answers the chat\'s id and title', async () => {
    const { items, routes } = await setUp();
    items.ensure.calledWith(TEST_USER.id, matches<ChatItem>((item) => item.kind === 'story' && item.leafId === 'l1')).mockResolvedValue(chat('story-l1', 'Checkout'));
    expect(plain(await routes.post('/story/l1/chat'))).toEqual({ status: 200, body: { id: 'story-l1', title: 'Checkout' } });
  });

  it('asks for a feature\'s chat by its branch', async () => {
    const { items, routes } = await setUp();
    items.ensure.calledWith(TEST_USER.id, matches<ChatItem>((item) => item.kind === 'feature' && item.branchId === 'b1')).mockResolvedValue(chat('feature-b1', 'Payments'));
    expect(plain(await routes.post('/feature/b1/chat'))).toEqual({ status: 200, body: { id: 'feature-b1', title: 'Payments' } });
  });

  it('refuses any other kind of item without asking the service', async () => {
    const { items, routes } = await setUp();
    expect(plain(await routes.post('/epic/t1/chat'))).toEqual({ status: 404, body: { error: 'Only a story or a feature has its own chat' } });
    expect(items.ensure).not.toHaveBeenCalled();
  });

  it('answers 404 naming the kind when the person has no such item', async () => {
    const { items, routes } = await setUp();
    items.ensure.mockResolvedValue(undefined);
    expect(plain(await routes.post('/story/nope/chat'))).toEqual({ status: 404, body: { error: 'No such story' } });
    expect(plain(await routes.post('/feature/nope/chat'))).toEqual({ status: 404, body: { error: 'No such feature' } });
  });
});
