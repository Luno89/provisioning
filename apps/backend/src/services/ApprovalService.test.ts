import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { ApprovalService } from './ApprovalService.js';

let db: MemoryDB;
const approve = vi.fn(async () => undefined);

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  approve.mockClear();
  await db.saveConversation({ id: 'c1', ownerId: 'bo', title: 'chat', messages: [], createdAt: 'now', updatedAt: 'now' });
  await db.appendTurnLog({ turnId: 'run-1', ownerId: 'bo', seq: 1, at: 'now', events: [{ type: 'run.started', runId: 'run-1-check-writer-1' } as never] });
});

const service = () => new ApprovalService({ store: db, runs: { approve } });

describe('approving a tool call', () => {
  it('lets only the run\'s owner approve it, for the run itself or one it handed work to', async () => {
    expect(await service().approve('bo', 'run-1-check-writer-1', { callId: 'x', allowed: true })).toBe('sent');
    expect(await service().approve('cy', 'run-1-check-writer-1', { callId: 'x', allowed: true })).toBe('not-yours');
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('remembers a tool allowed in a conversation, so it is not asked for again there', async () => {
    expect(await service().approve('bo', 'run-1', { callId: 'x', allowed: true, conversation: { id: 'c1', tool: 'update_check' } })).toBe('sent');
    expect((await db.getConversation('bo', 'c1'))?.allowedTools).toEqual(['update_check']);
    await service().approve('bo', 'run-1', { callId: 'y', allowed: true, conversation: { id: 'c1', tool: 'update_check' } });
    expect((await db.getConversation('bo', 'c1'))?.allowedTools).toEqual(['update_check']);
  });

  it('remembers nothing for a refusal, or for a conversation that is not the person\'s', async () => {
    await service().approve('bo', 'run-1', { callId: 'x', allowed: false, conversation: { id: 'c1', tool: 'delete_check' } });
    expect((await db.getConversation('bo', 'c1'))?.allowedTools).toBeUndefined();
    expect(await service().approve('bo', 'run-1', { callId: 'x', allowed: true, conversation: { id: 'not-mine', tool: 'delete_check' } })).toBe('no-such-conversation');
  });
});
