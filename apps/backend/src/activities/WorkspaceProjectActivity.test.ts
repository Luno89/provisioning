import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { createWorkspaceProjectActivities } from './WorkspaceProjectActivity.js';

describe('which project a workspace being concluded works for', () => {
  it('is its tree\'s project or its chat\'s, and none for a tree or chat with no project, or another owner\'s', async () => {
    const db = memoryDatabase();
    const at = '2026-11-13T10:00:00.000Z';
    await db.projects.saveTree({ id: 't1', ownerId: 'u1', name: 'Shop', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
    await db.projects.saveTree({ id: 't2', ownerId: 'u1', name: 'Notes', projectIds: [], createdAt: at, updatedAt: at } as never);
    await db.engine.saveConversation({ id: 'c1', ownerId: 'u1', projectId: 'p2', title: 'chat', messages: [], createdAt: at, updatedAt: at } as never);
    await db.engine.saveConversation({ id: 'c2', ownerId: 'u1', title: 'chat', messages: [], createdAt: at, updatedAt: at } as never);
    const { WorkspaceProjectActivity } = createWorkspaceProjectActivities(db);
    const asked = (ownerId: string, kind: 'tree' | 'conversation', id: string) => new MockActivityEnvironment().run(WorkspaceProjectActivity, { ownerId, workspace: { kind, id } });
    expect(await asked('u1', 'tree', 't1')).toBe('p1');
    expect(await asked('u1', 'tree', 't2')).toBeNull();
    expect(await asked('u1', 'conversation', 'c1')).toBe('p2');
    expect(await asked('u1', 'conversation', 'c2')).toBeNull();
    expect(await asked('someone', 'tree', 't1')).toBeNull();
  });
});
