import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { servedWindowsOverHttp } from './served-windows.js';

interceptHttp(
  http.get('http://vllm.test/v1/models', () => HttpResponse.json({ data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 40960 }] })),
  http.get('http://tabby.test/v1/model', ({ request }) => (request.headers.get('authorization') === 'Bearer key'
    ? HttpResponse.json({ id: 'q', parameters: { max_seq_len: 65536 } })
    : new HttpResponse(null, { status: 401 }))),
  http.get('http://gone.test/v1/models', () => new HttpResponse(null, { status: 404 })),
);

describe('asking a model server what window it serves', () => {
  const windows = servedWindowsOverHttp();

  it('reads vLLM\'s model list and TabbyAPI\'s loaded model, with the endpoint\'s key', async () => {
    expect(await windows.read({ baseUrl: 'http://vllm.test/v1', kind: 'vllm', model: 'Qwen/Qwen3-8B' })).toBe(40960);
    expect(await windows.read({ baseUrl: 'http://tabby.test/v1', kind: 'tabbyapi', model: 'q', apiKey: 'key' })).toBe(65536);
  });

  it('has no answer when the server refuses or has no such route', async () => {
    expect(await windows.read({ baseUrl: 'http://tabby.test/v1', kind: 'tabbyapi', model: 'q' })).toBeUndefined();
    expect(await windows.read({ baseUrl: 'http://gone.test/v1', model: 'x' })).toBeUndefined();
  });
});
