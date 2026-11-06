import { describe, it, expect, vi } from 'vitest';
import { ConversationTurnService, ENDED_UNSAVED } from './ConversationTurnService.js';
import type { Conversation } from '../lib/conversations.js';
import type { TurnLogEntry } from '../lib/turn-log.js';
import { testDatabase } from '../../platform/lib/test-database.js';

const at = '2026-10-05T00:00:00.000Z';

const world = async (running: boolean | Error, log: TurnLogEntry[] = []) => {
  const db = await testDatabase();
  for (const entry of log) await db.engine.appendTurnLog(entry);
  const saving = vi.spyOn(db.engine, 'saveConversation');
  const service = new ConversationTurnService({
    store: db.engine,
    log: db.engine,
    running: async () => { if (running instanceof Error) throw running; return running; },
    now: () => at,
  });
  return {
    service,
    saved: () => saving.mock.calls.map(([conversation]) => conversation),
    current: () => db.engine.getConversation('u1', 'c1'),
  };
};

describe('a conversation turn on the server', () => {
  it('is opened with the person\'s message before anything runs', async () => {
    const { service, current } = await world(true);
    await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });

    expect(await current()).toMatchObject({ id: 'c1', liveTurn: { runId: 'r1' }, messages: [{ role: 'user', content: 'hi', runId: 'r1' }] });
  });

  it('is left alone while its run is going, or when that cannot be told', async () => {
    for (const running of [true, new Error('Temporal is away')]) {
      const { service, saved, current } = await world(running);
      await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });
      const open = saved()[0]!;

      expect(await service.settle(open)).toBe(open);
      expect(saved()).toHaveLength(1);
      expect(await current()).toMatchObject({ liveTurn: { runId: 'r1' } });
    }
  });

  it('is closed with what its log holds, marked interrupted, once its run is gone without saving', async () => {
    const log: TurnLogEntry[] = [{ turnId: 'r1', ownerId: 'u1', seq: 1, at, events: [
      { type: 'content', runId: 'r1', at, nodeId: 'turn', delta: 'Half an answer' },
      { type: 'tool.called', runId: 'r1', at, nodeId: 'tools', callId: 'c1', name: 'get_logs', args: '{}' },
    ] }];
    const { service, saved, current } = await world(false, log);
    await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });

    const settled = await service.settle(saved()[0]!);

    expect(settled.liveTurn).toBeUndefined();
    expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', runId: 'r1', content: 'Half an answer', interruptedReason: ENDED_UNSAVED, toolCalls: [{ id: 'c1', name: 'get_logs', ok: false }] });
    expect(saved().at(-1)).toEqual(settled);
    expect((await current())!.messages.at(-1)).toMatchObject({ content: 'Half an answer', interruptedReason: ENDED_UNSAVED });
    expect((await current())!.liveTurn).toBeUndefined();
  });

  it('is closed with why when its run could not start', async () => {
    const { service, current } = await world(false);
    await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });
    await service.fail({ ownerId: 'u1', conversationId: 'c1', runId: 'r1' }, 'the run could not start: Temporal is down');

    expect((await current())!.liveTurn).toBeUndefined();
    expect((await current())!.messages.at(-1)).toMatchObject({ role: 'assistant', content: '', interruptedReason: 'the run could not start: Temporal is down' });
  });
});

describe('a turn opened on someone else\'s conversation', () => {
  it('is refused, and their conversation is left as it was', async () => {
    const db = await testDatabase();
    const theirs: Conversation = { id: 'c-theirs', ownerId: 'bo', title: 'Private', messages: [{ role: 'user', content: 'my secret plans', at }], createdAt: at, updatedAt: at };
    await db.engine.saveConversation(theirs);
    const service = new ConversationTurnService({ store: db.engine, log: db.engine, running: async () => true, now: () => at });
    await expect(service.open({ ownerId: 'eve', conversationId: 'c-theirs', runId: 'r1', message: 'overwrite it' })).rejects.toThrow('You have no conversation with that id.');
    expect(await db.engine.getConversation('bo', 'c-theirs')).toMatchObject({ ownerId: 'bo', messages: [{ content: 'my secret plans' }] });
    expect(await db.engine.getConversation('eve', 'c-theirs')).toBeUndefined();
  });
});
