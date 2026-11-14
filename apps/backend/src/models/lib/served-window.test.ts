import { describe, expect, it } from 'vitest';
import { servedWindowFrom, servedWindowPath } from './served-window.js';

describe('the context window a model server says it serves', () => {
  it('is vLLM\'s max_model_len for the model it serves', () => {
    const body = { object: 'list', data: [{ id: 'Qwen/Qwen3-8B', object: 'model', max_model_len: 40960 }] };
    expect(servedWindowFrom('vllm', body, 'Qwen/Qwen3-8B')).toBe(40960);
  });

  it('is TabbyAPI\'s max_seq_len for the model it has loaded', () => {
    const body = { id: 'Qwen3-8B-exl3', object: 'model', parameters: { max_seq_len: 32768, cache_size: 32768 } };
    expect(servedWindowFrom('tabbyapi', body, 'Qwen3-8B-exl3')).toBe(32768);
  });

  it('reads an OpenAI-compatible listing\'s context_length or max_model_len for the model named', () => {
    const body = { data: [{ id: 'a', context_length: 8192 }, { id: 'b', max_model_len: 65536 }] };
    expect(servedWindowFrom(undefined, body, 'a')).toBe(8192);
    expect(servedWindowFrom(undefined, body, 'b')).toBe(65536);
  });

  it('takes vLLM\'s only model when it is served under another name', () => {
    expect(servedWindowFrom('vllm', { data: [{ id: 'served-name', max_model_len: 131072 }] }, 'Qwen/Qwen3-8B')).toBe(131072);
  });

  it('says nothing when the server does not say, or names no such model among several', () => {
    expect(servedWindowFrom('vllm', { data: [{ id: 'x' }] }, 'x')).toBeUndefined();
    expect(servedWindowFrom(undefined, { data: [{ id: 'a', context_length: 1 }, { id: 'b', context_length: 2 }] }, 'c')).toBeUndefined();
    expect(servedWindowFrom('tabbyapi', { parameters: { max_seq_len: 0 } }, 'x')).toBeUndefined();
    expect(servedWindowFrom('vllm', 'not json', 'x')).toBeUndefined();
  });

  it('is asked of TabbyAPI\'s loaded model and of everyone else\'s model list', () => {
    expect(servedWindowPath('tabbyapi')).toBe('/model');
    expect(servedWindowPath('vllm')).toBe('/models');
    expect(servedWindowPath(undefined)).toBe('/models');
  });
});
