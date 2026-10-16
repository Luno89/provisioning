import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

export const ACP_STUB = `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let loaded = '';
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const params = message.params || {};
  if (message.method === 'initialize') {
    return send({ id: message.id, result: {
      protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'stub', name: 'Stub sign-in' }],
      agentInfo: { name: 'stub-agent', title: 'Stub Agent', version: '1.2.3' },
    } });
  }
  if (message.method === 'session/new') return send({ id: message.id, result: { sessionId: 'stub-1' } });
  if (message.method === 'session/load') { loaded = params.sessionId; return send({ id: message.id, result: {} }); }
  if (message.method === 'session/prompt') {
    const text = (params.prompt || []).map((block) => block.text || '').join('');
    const said = (loaded ? 'loaded ' + loaded + ', ' : '') + 'stub heard ' + text.length + ' characters ending ' + text.slice(-24);
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said } } } });
    return send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: message.id, result: {} });
});
`;

export interface Api {
  (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: unknown }>;
}

interface Message { role: string; content: string; runId?: string; interruptedReason?: string }
interface Conversation { messages: Message[]; liveTurn?: unknown; machineSessions?: Record<string, string> }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function turn(api: Api, conversationId: string, modelId: string, message: string): Promise<Message> {
  const started = await api('POST', '/engine/runs', { agent: 'koala', message, conversationId, modelId });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const { runId } = started.data as { runId: string };
  for (;;) {
    const { data } = await api('GET', `/conversations/${conversationId}`);
    const conversation = data as Conversation;
    const answer = conversation.messages.find((one) => one.role === 'assistant' && one.runId === runId);
    if (answer && !conversation.liveTurn) return answer;
    await sleep(2000);
  }
}

export async function chatsOnTheMachine(api: Api, deviceId: string, agent = 'gemini'): Promise<string[]> {
  const modelId = `machine:${deviceId}:${agent}`;
  const made = await api('POST', '/conversations', { title: 'A chat on the machine' });
  assert.equal(made.status < 300, true, JSON.stringify(made.data));
  const conversationId = (made.data as { id: string }).id;
  try {
    assert.equal((await api('PATCH', `/conversations/${conversationId}`, { modelId })).status, 200);
    const pasted = `Check these: ${randomBytes(200_000).toString('hex')}`;

    const first = await turn(api, conversationId, modelId, pasted);
    assert.equal(first.interruptedReason, undefined, `the machine did not take the turn: ${first.interruptedReason}`);
    assert.match(first.content, /^stub heard \d+ characters ending /, first.content.slice(0, 300));
    assert.ok(first.content.endsWith(pasted.slice(-24)), 'the machine did not get the whole message');
    assert.ok(Number(/heard (\d+)/.exec(first.content)![1]) > pasted.length, 'the machine did not get its prompt with the message');

    const second = await turn(api, conversationId, modelId, 'And again?');
    assert.equal(second.interruptedReason, undefined, `the machine did not take the second turn: ${second.interruptedReason}`);
    assert.match(second.content, /^loaded stub-1, stub heard 10 characters ending And again\?$/);
    const { data } = await api('GET', `/conversations/${conversationId}`);
    assert.deepEqual((data as Conversation).machineSessions, { [`${deviceId}:${agent}`]: 'stub-1' });
    return [first.content.slice(0, 60), second.content];
  } finally {
    await api('DELETE', `/conversations/${conversationId}`);
  }
}
