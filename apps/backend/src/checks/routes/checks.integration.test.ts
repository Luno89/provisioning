import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import type { ModelEndpointMetadata } from '../../platform/index.js';
import type { CheckScript } from '../lib/check-script.js';
import { spaceUser } from '../lib/check-space.js';
import { ScriptedModelService } from '../services/ScriptedModelService.js';
import { checksRouter, SCRIPTED_MODEL } from './checks.js';

const KEY = 'test-key' as never;
const TOKEN = 'a-long-secret-token';
const SPACE = 'space-1';

const SCRIPT: CheckScript = {
  rules: [
    { when: { asked: 'weather' }, reply: { say: 'It is dry.' } },
    { when: { asked: 'paced' }, reply: { say: 'one two three', paceMs: 1 } },
    { when: { asked: 'think' }, reply: { think: Array.from({ length: 45 }, (_, index) => `word${index}`).join(' '), say: 'Starting.', call: [{ tool: 'start_task', arguments: { id: 't-1' } }, { tool: 'mark_done', arguments: {} }] } },
  ],
};

const quiet = { validateStatus: () => true };
const as = (token: string) => ({ ...quiet, headers: { authorization: `Bearer ${token}` } });
const ask = (text: string) => ({ messages: [{ role: 'user', content: text }] });

type Chunk = { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: Record<string, number>; model: string };
const chunks = (body: unknown): Chunk[] => String(body).split('\n\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice('data: '.length)) as Chunk);

let harness: Harness;

beforeAll(async () => {
  harness = await mountRouter({
    prefix: '/api/checks',
    router: (db) => checksRouter({ scripted: new ScriptedModelService({ store: db, dataKey: KEY }) }),
  });
});

afterAll(async () => { await harness.close(); });

beforeEach(async () => {
  const { db } = harness;
  await db.accounts.saveUser({ ...spaceUser(SPACE, { person: 'bo', checkRunId: 'c1', scenarioId: 's', script: SCRIPT }, 't'), space: { person: 'bo', checkRunId: 'c1', scenarioId: 's', models: 'scripted', script: SCRIPT } });
  await db.models.saveModelEndpoint({ id: `scripted-${SPACE}`, ownerId: SPACE, name: 'Scripted model', baseUrl: 'http://x/v1', model: 'scripted', apiKeyEnc: encryptValue(TOKEN, KEY), createdAt: 't' } as ModelEndpointMetadata);
  harness.setUser({ id: SPACE, email: 'space@example.com' });
});

describe('/api/checks/scripted over HTTP', () => {
  it('lists the one model a check\'s key may use, and refuses any other key', async () => {
    const listed = await axios.get(harness.url(`/api/checks/scripted/${SPACE}/v1/models`), as(TOKEN));
    expect(listed).toMatchObject({ status: 200, data: { object: 'list', data: [{ id: SCRIPTED_MODEL, object: 'model' }] } });
    expect(await axios.get(harness.url(`/api/checks/scripted/${SPACE}/v1/models`), as('wrong'))).toMatchObject({ status: 401, data: { error: { message: 'that is not this check\'s key' } } });
    expect((await axios.get(harness.url(`/api/checks/scripted/${SPACE}/v1/models`), quiet)).status).toBe(401);
  });

  it('streams what the script says as a chat completion, ends it with a usage count and the end marker, and records the request', async () => {
    const reply = await axios.post(harness.url(`/api/checks/scripted/${SPACE}/v1/chat/completions`), ask('weather?'), { ...as(TOKEN), responseType: 'text' });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/event-stream');
    const sent = chunks(reply.data);
    expect(sent[0]!.choices[0]!.delta).toEqual({ role: 'assistant' });
    expect(sent[1]!.choices[0]!.delta).toEqual({ content: 'It is dry.' });
    expect(sent.at(-1)).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 20 } });
    expect(String(reply.data).endsWith('data: [DONE]\n\n')).toBe(true);
    const requests = await axios.get(harness.url('/api/checks/model-requests'), quiet);
    expect(requests).toMatchObject({ status: 200, data: { requests: [{ ownerId: SPACE, text: '[user] weather?', rule: 0 }] } });
  });

  it('streams thinking in pieces before the answer, and each call as a tool call that ends the turn', async () => {
    const sent = chunks((await axios.post(harness.url(`/api/checks/scripted/${SPACE}/v1/chat/completions`), ask('think'), { ...as(TOKEN), responseType: 'text' })).data);
    expect(sent.filter((entry) => 'reasoning_content' in entry.choices[0]!.delta).length).toBe(3);
    const calls = sent.filter((entry) => 'tool_calls' in entry.choices[0]!.delta).map((entry) => (entry.choices[0]!.delta.tool_calls as Array<{ index: number; function: { name: string; arguments: string } }>)[0]!);
    expect(calls.map((call) => [call.index, call.function.name, call.function.arguments])).toEqual([[0, 'start_task', '{"id":"t-1"}'], [1, 'mark_done', '{}']]);
    expect(sent.at(-1)!.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('says a paced answer a word at a time', async () => {
    const sent = chunks((await axios.post(harness.url(`/api/checks/scripted/${SPACE}/v1/chat/completions`), ask('paced'), { ...as(TOKEN), responseType: 'text' })).data);
    expect(sent.filter((entry) => 'content' in entry.choices[0]!.delta).map((entry) => entry.choices[0]!.delta.content)).toEqual(['one ', 'two ', 'three']);
  });

  it('refuses a key that is not the check\'s, and says what the script could not answer', async () => {
    expect(await axios.post(harness.url(`/api/checks/scripted/${SPACE}/v1/chat/completions`), ask('weather'), as('wrong'))).toMatchObject({ status: 401, data: { error: { message: 'that is not this check\'s key' } } });
    expect(await axios.post(harness.url('/api/checks/scripted/nobody/v1/chat/completions'), ask('weather'), as(TOKEN))).toMatchObject({ status: 404, data: { error: { message: 'there is no scripted check here' } } });
    const missed = await axios.post(harness.url(`/api/checks/scripted/${SPACE}/v1/chat/completions`), ask('something else'), as(TOKEN));
    expect(missed.status).toBe(422);
    expect((missed.data as { error: { message: string } }).error.message).toContain('the script has no answer');
  });

  it('lists only the requests the signed-in person\'s check was sent', async () => {
    await axios.post(harness.url(`/api/checks/scripted/${SPACE}/v1/chat/completions`), ask('weather'), as(TOKEN));
    harness.setUser({ id: 'someone-else', email: 'else@example.com' });
    expect(await axios.get(harness.url('/api/checks/model-requests'), quiet)).toMatchObject({ status: 200, data: { requests: [] } });
  });
});
