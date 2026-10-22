import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { ApprovalService } from './ApprovalService.js';

let db: MongoDB;
const approve = vi.fn(async () => undefined);

beforeEach(async () => {
  db = await testDatabase();
  approve.mockClear();
  await db.engine.saveConversation({ id: 'c1', ownerId: 'bo', title: 'chat', messages: [], createdAt: 'now', updatedAt: 'now' });
  await db.engine.appendTurnLog({ turnId: 'run-1', ownerId: 'bo', seq: 1, at: 'now', events: [{ type: 'run.started', runId: 'run-1-check-writer-1' } as never] });
});

const service = () => new ApprovalService({ store: db.engine, runs: { approve } });

describe('approving a tool call', () => {
  it('lets only the run\'s owner approve it, for the run itself or one it handed work to', async () => {
    expect(await service().approve('bo', 'run-1-check-writer-1', { callId: 'x', allowed: true })).toBe('sent');
    expect(await service().approve('cy', 'run-1-check-writer-1', { callId: 'x', allowed: true })).toBe('not-yours');
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('remembers a tool allowed in a conversation, so it is not asked for again there', async () => {
    expect(await service().approve('bo', 'run-1', { callId: 'x', allowed: true, conversation: { id: 'c1', tool: 'update_check' } })).toBe('sent');
    expect((await db.engine.getConversation('bo', 'c1'))?.allowedTools).toEqual(['update_check']);
    await service().approve('bo', 'run-1', { callId: 'y', allowed: true, conversation: { id: 'c1', tool: 'update_check' } });
    expect((await db.engine.getConversation('bo', 'c1'))?.allowedTools).toEqual(['update_check']);
  });

  it('remembers nothing for a refusal, or for a conversation that is not the person\'s', async () => {
    await service().approve('bo', 'run-1', { callId: 'x', allowed: false, conversation: { id: 'c1', tool: 'delete_check' } });
    expect((await db.engine.getConversation('bo', 'c1'))?.allowedTools).toBeUndefined();
    expect(await service().approve('bo', 'run-1', { callId: 'x', allowed: true, conversation: { id: 'not-mine', tool: 'delete_check' } })).toBe('no-such-conversation');
  });

  it('switches on auto mode for the agent asking, or the tree its run works in, before allowing the call', async () => {
    await db.engine.appendTurnLog({ turnId: 'grove-run-t1~abc', ownerId: 'bo', seq: 1, at: 'now', events: [{ type: 'run.started', runId: 'grove-run-t1~abc-grove-leaf-1-executor-1', agentId: 'executor' } as never] });
    const setAgent = vi.fn(async () => ({ ok: true as const }));
    const setTree = vi.fn(async () => ({ ok: true as const }));
    const withAuto = new ApprovalService({ store: db.engine, runs: { approve }, autoMode: { setAgent, setTree }, treeOfRun: (turnId) => /^grove-run-([^~]+)~/.exec(turnId)?.[1] });
    const run = 'grove-run-t1~abc-grove-leaf-1-executor-1';

    expect(await withAuto.approve('bo', run, { callId: 'x', allowed: true, auto: 'agent' })).toBe('sent');
    expect(setAgent).toHaveBeenCalledWith('bo', 'executor', { on: true });
    expect(await withAuto.approve('bo', run, { callId: 'y', allowed: true, auto: 'tree' })).toBe('sent');
    expect(setTree).toHaveBeenCalledWith('bo', 't1', { on: true });
    expect(approve).toHaveBeenCalledTimes(2);

    expect(await withAuto.approve('bo', 'run-1-check-writer-1', { callId: 'z', allowed: true, auto: 'tree' })).toEqual({ refused: 'this run is not part of a tree\'s work, so there is no tree to switch auto mode on for' });
    expect(await withAuto.approve('bo', run, { callId: 'w', allowed: false, auto: 'agent' })).toBe('sent');
    expect(setAgent).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(3);
  });
});
