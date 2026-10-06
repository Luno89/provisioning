import { describe, it, expect } from 'vitest';
import { ConversationTurnService, ENDED_UNSAVED } from './ConversationTurnService.js';
import type { Conversation } from '../lib/conversations.js';
import type { TurnLogEntry } from '../lib/turn-log.js';

const at = '2026-10-05T00:00:00.000Z';

const world = (running: boolean | Error, log: TurnLogEntry[] = []) => {
  const saved: Conversation[] = [];
  let current: Conversation | undefined;
  const service = new ConversationTurnService({
    store: {
      getConversation: async () => current,
      saveConversation: async (conversation) => { current = conversation; saved.push(conversation); },
    },
    log: { getTurnLog: async (_ownerId, turnId) => log.filter((entry) => entry.turnId === turnId) },
    running: async () => { if (running instanceof Error) throw running; return running; },
    now: () => at,
  });
  return { service, saved, current: () => current };
};

describe('a conversation turn on the server', () => {
  it('is opened with the person\'s message before anything runs', async () => {
    const { service, current } = world(true);
    await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });

    expect(current()).toMatchObject({ id: 'c1', liveTurn: { runId: 'r1' }, messages: [{ role: 'user', content: 'hi', runId: 'r1' }] });
  });

  it('is left alone while its run is going, or when that cannot be told', async () => {
    for (const running of [true, new Error('Temporal is away')]) {
      const { service, saved } = world(running);
      await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });
      const open = saved[0]!;

      expect(await service.settle(open)).toBe(open);
      expect(saved).toHaveLength(1);
    }
  });

  it('is closed with what its log holds, marked interrupted, once its run is gone without saving', async () => {
    const log: TurnLogEntry[] = [{ turnId: 'r1', ownerId: 'u1', seq: 1, at, events: [
      { type: 'content', runId: 'r1', at, nodeId: 'turn', delta: 'Half an answer' },
      { type: 'tool.called', runId: 'r1', at, nodeId: 'tools', callId: 'c1', name: 'get_logs', args: '{}' },
    ] }];
    const { service, saved } = world(false, log);
    await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });

    const settled = await service.settle(saved[0]!);

    expect(settled.liveTurn).toBeUndefined();
    expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', runId: 'r1', content: 'Half an answer', interruptedReason: ENDED_UNSAVED, toolCalls: [{ id: 'c1', name: 'get_logs', ok: false }] });
    expect(saved.at(-1)).toEqual(settled);
  });

  it('is closed with why when its run could not start', async () => {
    const { service, current } = world(false);
    await service.open({ ownerId: 'u1', conversationId: 'c1', runId: 'r1', message: 'hi' });
    await service.fail({ ownerId: 'u1', conversationId: 'c1', runId: 'r1' }, 'the run could not start: Temporal is down');

    expect(current()!.liveTurn).toBeUndefined();
    expect(current()!.messages.at(-1)).toMatchObject({ role: 'assistant', content: '', interruptedReason: 'the run could not start: Temporal is down' });
  });
});
