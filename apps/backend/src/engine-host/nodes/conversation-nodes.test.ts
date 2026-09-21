import { describe, it, expect } from 'vitest';
import { builtInCatalogue } from '@koala/agent-engine/procedure';
import { asChatMessages, asStoredToolCalls, createConversationNodes } from './conversation-nodes.js';
import type { ConversationStore } from './conversation-nodes.js';
import type { Conversation, ConversationMessage } from '../../lib/conversations.js';

const said = (over: Partial<ConversationMessage> & Pick<ConversationMessage, 'role' | 'content'>): ConversationMessage => ({
  at: '2026-09-20T00:00:00.000Z',
  ...over,
});

const reply = (over: Partial<Parameters<typeof asStoredToolCalls>[0]> = {}) => ({
  id: 'turn#1',
  content: 'three of them',
  thinking: 'let me count',
  finishReason: 'stop',
  toolCalls: [],
  ...over,
});

function store(seed: Conversation[] = []) {
  const rows = [...seed];
  const kept: ConversationStore = {
    get: async (ownerId, id) => rows.find((one) => one.id === id && one.ownerId === ownerId),
    save: async (conversation) => {
      const at = rows.findIndex((one) => one.id === conversation.id);
      if (at === -1) rows.push(conversation); else rows[at] = conversation;
    },
  };
  return { rows, kept };
}

const run = (over: Record<string, unknown> = {}) => ({
  identity: { runId: 'r', depth: 0, agentId: 'koala', loopId: 'interactive-chat', loopVersion: '2', trigger: 'user' as const },
  launch: { ownerId: 'user-1' },
  handles: {},
  inputs: {},
  counters: {} as never,
  budget: {},
  cleaningUp: false,
  emit: () => undefined,
  ...over,
});

const request = (kind: string, inputs: Record<string, unknown>, settings: Record<string, unknown>) => ({
  node: { id: kind, kind, settings, position: [0, 0] as never },
  origin: kind,
  definition: builtInCatalogue().get(kind)!,
  inputs,
  execution: 1,
  run: run(),
}) as never;

const nodes = (kept: ConversationStore) => {
  const made = createConversationNodes(kept);
  return {
    load: made.find((one) => one.kind === 'load-conversation')!,
    save: made.find((one) => one.kind === 'save-conversation')!,
  };
};

describe('turning a stored conversation into messages for the model', () => {
  it('keeps what was said, oldest first', () => {
    expect(asChatMessages([
      said({ role: 'user', content: 'hello' }),
      said({ role: 'assistant', content: 'hello back' }),
    ])).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('drops a message with nothing in it, so an empty salvage does not confuse the model', () => {
    expect(asChatMessages([
      said({ role: 'user', content: 'hello' }),
      said({ role: 'assistant', content: '   ' }),
    ])).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('starts from the last handoff, the way the old chat did', () => {
    const messages = asChatMessages([
      said({ role: 'user', content: 'long ago' }),
      said({ role: 'assistant', content: 'carrying on from before', handoff: true }),
      said({ role: 'user', content: 'and now' }),
    ]);

    expect(messages.map((one) => one.content)).toEqual(['carrying on from before', 'and now']);
  });
});

describe('recording what the tools did', () => {
  it('answers each call with its own result', () => {
    const calls = asStoredToolCalls(
      reply({ toolCalls: [{ id: 'c1', name: 'json_query', arguments: '{}' }] }) as never,
      [{ forReply: 'turn#1', callId: 'c1', name: 'json_query', ok: true, content: '3' }] as never,
    );

    expect(calls).toEqual([{ id: 'c1', name: 'json_query', args: '{}', ok: true, digest: '3' }]);
  });

  it('records a call that never came back as not ok', () => {
    const calls = asStoredToolCalls(
      reply({ toolCalls: [{ id: 'c9', name: 'read_file', arguments: '{}' }] }) as never,
      [] as never,
    );

    expect(calls[0]).toMatchObject({ id: 'c9', ok: false, digest: '' });
  });
});

describe('loading a conversation into a run', () => {
  it('hands back what was said before', async () => {
    const { kept } = store([{
      id: 'c-1', ownerId: 'user-1', title: 'Counting', createdAt: 'x', updatedAt: 'x',
      messages: [said({ role: 'user', content: 'how many?' })],
    } as Conversation]);

    const outcome = await nodes(kept).load.run(request('load-conversation', { values: { conversationId: 'c-1' } }, { id: '{{values.conversationId}}' })) as { outputs: Record<string, unknown> };

    expect(outcome.outputs.found).toBe(true);
    expect(outcome.outputs.messages).toEqual([{ role: 'user', content: 'how many?' }]);
  });

  it('starts empty when there is nothing stored yet, rather than failing', async () => {
    const { kept } = store();

    const outcome = await nodes(kept).load.run(request('load-conversation', { values: { conversationId: 'fresh' } }, { id: '{{values.conversationId}}' })) as { outputs: Record<string, unknown> };

    expect(outcome.outputs).toEqual({ messages: [], found: false });
  });

  it('will not read another owner’s conversation', async () => {
    const { kept } = store([{
      id: 'c-1', ownerId: 'somebody-else', title: 'Theirs', createdAt: 'x', updatedAt: 'x',
      messages: [said({ role: 'user', content: 'private' })],
    } as Conversation]);

    const outcome = await nodes(kept).load.run(request('load-conversation', { values: { conversationId: 'c-1' } }, { id: '{{values.conversationId}}' })) as { outputs: Record<string, unknown> };

    expect(outcome.outputs).toEqual({ messages: [], found: false });
  });
});

describe('saving a turn onto a conversation', () => {
  const saving = (inputs: Record<string, unknown>, settings: Record<string, unknown> = { id: '{{values.conversationId}}' }) =>
    request('save-conversation', inputs, settings);

  it('creates one that does not exist, named after what was asked', async () => {
    const { rows, kept } = store();

    const outcome = await nodes(kept).save.run(saving({
      values: { conversationId: 'c-new' },
      asked: 'how many items are done?',
      reply: reply(),
    })) as { exit: string };

    expect(outcome.exit).toBe('saved');
    expect(rows[0]).toMatchObject({ id: 'c-new', ownerId: 'user-1', title: 'how many items are done?' });
    expect(rows[0]!.messages.map((one) => [one.role, one.content])).toEqual([
      ['user', 'how many items are done?'],
      ['assistant', 'three of them'],
    ]);
  });

  it('appends to one that exists, keeping what was already there', async () => {
    const { rows, kept } = store([{
      id: 'c-1', ownerId: 'user-1', title: 'Counting', createdAt: 'x', updatedAt: 'x',
      messages: [said({ role: 'user', content: 'earlier' })],
    } as Conversation]);

    await nodes(kept).save.run(saving({ values: { conversationId: 'c-1' }, asked: 'and now?', reply: reply() }));

    expect(rows[0]!.messages.map((one) => one.content)).toEqual(['earlier', 'and now?', 'three of them']);
    expect(rows[0]!.title).toBe('Counting');
  });

  it('keeps the thinking and the tool calls alongside the answer', async () => {
    const { rows, kept } = store();

    await nodes(kept).save.run(saving({
      values: { conversationId: 'c-2' },
      asked: 'count them',
      reply: reply({ toolCalls: [{ id: 'c1', name: 'json_query', arguments: '{}' }] }),
      results: [[{ forReply: 'turn#1', callId: 'c1', name: 'json_query', ok: true, content: '3' }]],
    }));

    const assistant = rows[0]!.messages[1]!;
    expect(assistant.reasoning).toBe('let me count');
    expect(assistant.toolCalls).toEqual([{ id: 'c1', name: 'json_query', args: '{}', ok: true, digest: '3' }]);
  });

  it('falls back to the run when it was told no conversation, so the turn still lands somewhere', async () => {
    const { rows, kept } = store();

    const outcome = await nodes(kept).save.run(saving({ values: {}, asked: 'hello', reply: reply() })) as { exit: string };

    expect(outcome.exit).toBe('saved');
    expect(rows[0]).toMatchObject({ id: 'r', ownerId: 'user-1' });
  });

  it('reads back from the same fallback, so a run started twice carries on', async () => {
    const { kept } = store();

    await nodes(kept).save.run(saving({ values: {}, asked: 'hello', reply: reply() }));
    const loaded = await nodes(kept).load.run(request('load-conversation', { values: {} }, { id: '{{values.conversationId}}' })) as { outputs: Record<string, unknown> };

    expect(loaded.outputs.found).toBe(true);
    expect((loaded.outputs.messages as unknown[]).length).toBe(2);
  });
});
