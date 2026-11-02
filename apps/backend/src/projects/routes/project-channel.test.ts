import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Conversation } from '../../engine/index.js';
import type { ProjectMetadata } from '../../platform/index.js';
import { CALLER, get } from '../testing/route-call.js';
import type { ProjectChannelService } from '../services/ProjectChannelService.js';
import { projectChannelRouter } from './project-channel.js';

const project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: CALLER.id, appType: 'gitapp', createdAt: 't' };
const conversation = (over: Partial<Conversation>): Conversation => ({ id: 'c', ownerId: CALLER.id, title: 'chat', messages: [], createdAt: 't', updatedAt: 't', ...over });

function setUp(conversations: Conversation[], owned: ProjectMetadata | undefined = project) {
  const channels = mock<ProjectChannelService>();
  channels.ensure.mockResolvedValue(conversation({ id: 'channel-p1', title: 'Shop', kind: 'channel', projectId: 'p1', treeId: 't1' }));
  const router = projectChannelRouter({ channels, conversations: async () => conversations, getOwnedProject: async (id) => (id === owned?.id ? owned : undefined) });
  return { channels, router };
}

describe('a project\'s channel', () => {
  it('lists as threads the other chats about the project or its tree, newest first, without items or itself', async () => {
    const { router } = setUp([
      conversation({ id: 'channel-p1', kind: 'channel', projectId: 'p1' }),
      conversation({ id: 'old', title: 'Older', projectId: 'p1', updatedAt: '2026-01-01', messages: [{ role: 'user', content: 'hi', at: 't' }] }),
      conversation({ id: 'new', title: 'Newer', treeId: 't1', updatedAt: '2026-02-01' }),
      conversation({ id: 'story-l1', kind: 'item', projectId: 'p1' }),
      conversation({ id: 'elsewhere', projectId: 'p2' }),
    ]);
    expect(await get(router, '/p1/channel')).toEqual({
      status: 200,
      body: {
        channel: { id: 'channel-p1', title: 'Shop' },
        threads: [
          { id: 'new', title: 'Newer', updatedAt: '2026-02-01', messageCount: 0 },
          { id: 'old', title: 'Older', updatedAt: '2026-01-01', messageCount: 1 },
        ],
      },
    });
  });

  it('answers 404 for a project the caller cannot see, without making a channel', async () => {
    const { channels, router } = setUp([]);
    expect(await get(router, '/p9/channel')).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(channels.ensure).not.toHaveBeenCalled();
  });

  it('answers 409 when the project has no owner and so no channel', async () => {
    const { channels, router } = setUp([]);
    channels.ensure.mockResolvedValue(undefined);
    expect(await get(router, '/p1/channel')).toEqual({ status: 409, body: { error: 'The project has no owner, so it has no channel' } });
  });
});
