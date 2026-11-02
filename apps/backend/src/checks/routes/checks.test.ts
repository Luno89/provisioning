import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import type { ScriptAnswer } from '../lib/check-script.js';
import type { ScriptedModelService } from '../services/ScriptedModelService.js';
import { checksRouter, SCRIPTED_MODEL } from './checks.js';

let scripted: ReturnType<typeof mock<ScriptedModelService>>;
let app: InProcessRoutes;

const chunks = (body: unknown): Array<{ choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: Record<string, number>; model: string }> =>
  String(body).split('\n\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice('data: '.length)) as never);

const answering = (answer: ScriptAnswer) => scripted.answer.mockResolvedValue({ answer });

beforeEach(async () => {
  scripted = mock<ScriptedModelService>();
  app = await routesInProcess({ prefix: '/api/checks', router: () => checksRouter({ scripted }) });
});

describe('/api/checks/scripted', () => {
  it('lists the one model a check\'s key may use, and refuses any other key', async () => {
    scripted.knows.mockResolvedValue(true);
    expect(await app.get('/api/checks/scripted/space-1/v1/models')).toMatchObject({ status: 200, data: { object: 'list', data: [{ id: SCRIPTED_MODEL, object: 'model' }] } });
    scripted.knows.mockResolvedValue(false);
    expect(await app.get('/api/checks/scripted/space-1/v1/models')).toMatchObject({ status: 401, data: { error: { message: 'that is not this check\'s key' } } });
  });

  it('streams what the script says as a chat completion, and ends it with a usage count and the end marker', async () => {
    answering({ say: 'It is dry.', calls: [] });
    const reply = await app.post('/api/checks/scripted/space-1/v1/chat/completions', { messages: [{ role: 'user', content: 'weather?' }] });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/event-stream');
    const sent = chunks(reply.data);
    expect(sent[0]!.choices[0]!.delta).toEqual({ role: 'assistant' });
    expect(sent[1]!.choices[0]!.delta).toEqual({ content: 'It is dry.' });
    expect(sent.at(-1)).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 20 } });
    expect(String(reply.data).endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('hands the space and the body the model was sent to the script, with an empty key when none is given', async () => {
    answering({ say: 'ok', calls: [] });
    await app.post('/api/checks/scripted/space-9/v1/chat/completions', { messages: [] });
    expect(scripted.answer).toHaveBeenCalledWith('space-9', '', { messages: [] });
  });

  it('streams thinking in pieces before the answer, and each call as a tool call that ends the turn', async () => {
    const think = Array.from({ length: 45 }, (_, index) => `word${index}`).join(' ');
    answering({ think, say: 'Starting.', calls: [{ name: 'start_task', arguments: { id: 't-1' } }, { name: 'mark_done', arguments: {} }] });
    const sent = chunks((await app.post('/api/checks/scripted/space-1/v1/chat/completions', {})).data);
    const thinking = sent.filter((entry) => 'reasoning_content' in entry.choices[0]!.delta);
    expect(thinking.length).toBe(3);
    const calls = sent.filter((entry) => 'tool_calls' in entry.choices[0]!.delta).map((entry) => (entry.choices[0]!.delta.tool_calls as Array<{ index: number; function: { name: string; arguments: string } }>)[0]!);
    expect(calls.map((call) => [call.index, call.function.name, call.function.arguments])).toEqual([[0, 'start_task', '{"id":"t-1"}'], [1, 'mark_done', '{}']]);
    expect(sent.at(-1)!.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('says a paced answer a word at a time', async () => {
    answering({ say: 'one two three', calls: [], paceMs: 1 });
    const sent = chunks((await app.post('/api/checks/scripted/space-1/v1/chat/completions', {})).data);
    expect(sent.filter((entry) => 'content' in entry.choices[0]!.delta).map((entry) => entry.choices[0]!.delta.content)).toEqual(['one ', 'two ', 'three']);
  });

  it('refuses with the status and words the service gave, and says what the script could not answer', async () => {
    scripted.answer.mockResolvedValueOnce({ refused: 404, error: 'there is no scripted check here' });
    expect(await app.post('/api/checks/scripted/space-1/v1/chat/completions', {})).toMatchObject({ status: 404, data: { error: { message: 'there is no scripted check here' } } });
    scripted.answer.mockResolvedValueOnce({ miss: 'the script has no answer' });
    expect(await app.post('/api/checks/scripted/space-1/v1/chat/completions', {})).toMatchObject({ status: 422, data: { error: { message: 'the script has no answer' } } });
  });

  it('lists the requests the signed-in person\'s check was sent', async () => {
    scripted.requests.mockResolvedValue([{ ownerId: TEST_USER.id, at: 't', text: '[user] hi', tools: [], rule: 0 }]);
    expect(await app.get('/api/checks/model-requests')).toMatchObject({ status: 200, data: { requests: [{ text: '[user] hi' }] } });
    expect(scripted.requests).toHaveBeenCalledWith(TEST_USER.id);
  });
});
