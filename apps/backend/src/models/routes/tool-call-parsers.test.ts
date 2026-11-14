import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { ChatTemplateUnread } from '../services/ChatTemplates.js';
import type { ToolCallParsers } from '../services/ToolCallParsers.js';
import { toolCallParsersRouter } from './tool-call-parsers.js';

let parsers: MockProxy<Pick<ToolCallParsers, 'list' | 'pick'>>;

const routes = () => routesInProcess({ prefix: '/api/tool-call-parsers', router: () => toolCallParsersRouter({ parsers }), user: PERSON });

beforeEach(() => {
  parsers = mock<Pick<ToolCallParsers, 'list' | 'pick'>>();
  parsers.list.mockResolvedValue([
    { parser: 'hermes', label: 'Hermes, Qwen 2.5, QwQ, Qwen 3', template: [{ contains: '<tool_call>' }], names: [], shipped: true },
    { parser: 'mine', label: 'Mine', template: [], names: [], shipped: false },
  ]);
});

describe('the tool call parsers the browser lists', () => {
  it('are each parser\'s name and label', async () => {
    const answer = await (await routes()).get('/api/tool-call-parsers');
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual([{ parser: 'hermes', label: 'Hermes, Qwen 2.5, QwQ, Qwen 3' }, { parser: 'mine', label: 'Mine' }]);
  });
});

describe('the parser chosen for the model a person typed', () => {
  it('is picked as the person who asked, with the token they typed', async () => {
    parsers.pick.mockResolvedValue({ parser: 'hermes', from: 'template' });
    const answer = await (await routes()).post('/api/tool-call-parsers/pick', { model: 'Qwen/Qwen3-8B', hfToken: 'hf_typed' });
    expect(answer).toMatchObject({ status: 200, data: { parser: 'hermes', from: 'template' } });
    expect(parsers.pick).toHaveBeenCalledWith('Qwen/Qwen3-8B', { ownerId: PERSON.id, token: 'hf_typed' });
  });

  it('answers what stops a pick as the answer, not an error', async () => {
    parsers.pick.mockResolvedValue({ problem: 'pick a parser' });
    expect(await (await routes()).post('/api/tool-call-parsers/pick', { model: 'someone/model' })).toMatchObject({ status: 200, data: { problem: 'pick a parser' } });
  });

  it('refuses a request that names no model, and a token that is not text', async () => {
    const r = await routes();
    expect(await r.post('/api/tool-call-parsers/pick', {})).toMatchObject({ status: 400, data: { error: 'model must be the model\'s name on Hugging Face' } });
    expect(await r.post('/api/tool-call-parsers/pick', { model: 'a/b', hfToken: 7 })).toMatchObject({ status: 400, data: { error: 'hfToken must be text' } });
    expect(parsers.pick).not.toHaveBeenCalled();
  });

  it('answers 502 with why when Hugging Face did not answer', async () => {
    parsers.pick.mockRejectedValue(new ChatTemplateUnread('Hugging Face did not answer for a/b\'s chat template: it answered 503'));
    expect(await (await routes()).post('/api/tool-call-parsers/pick', { model: 'a/b' })).toMatchObject({ status: 502, data: { error: 'Hugging Face did not answer for a/b\'s chat template: it answered 503' } });
  });
});
