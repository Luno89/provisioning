import { beforeEach, describe, expect, it, vi } from 'vitest';
import { any, mock, type MockProxy } from 'vitest-mock-extended';
import { MemoryModelsStore } from '../testing/memory-store.js';
import type { ToolCallParser } from '../lib/tool-call-parsers.js';
import type { ChatTemplates } from './ChatTemplates.js';
import { ToolCallParsers } from './ToolCallParsers.js';

const row = (parser: string, over: Partial<ToolCallParser> = {}): ToolCallParser => ({ parser, label: parser, template: [], names: [], shipped: true, ...over });
const HERMES = row('hermes', { template: [{ contains: '<tool_call>{"name"' }] });
const MISTRAL = row('mistral', { template: [{ contains: '[TOOL_CALLS]' }], names: ['^mistralai/'] });
const PYTHONIC = row('pythonic');

let templates: MockProxy<ChatTemplates>;
let savedToken: ReturnType<typeof vi.fn<(ownerId: string | undefined) => Promise<string | undefined>>>;
let parsers: ToolCallParsers;

beforeEach(async () => {
  const store = new MemoryModelsStore();
  for (const parser of [HERMES, MISTRAL, PYTHONIC]) await store.saveToolCallParser(parser);
  templates = mock<ChatTemplates>();
  templates.read.calledWith('Qwen/Qwen3-8B', any()).mockResolvedValue({ template: '... <tool_call>{"name": ...' });
  templates.read.calledWith('mistralai/Mistral-7B-Instruct-v0.3', any()).mockResolvedValue({ template: '[TOOL_CALLS] [' });
  templates.read.calledWith('someone/their-own-model', any()).mockResolvedValue({ template: '{{ messages }}' });
  savedToken = vi.fn(async (ownerId: string | undefined) => (ownerId === 'ann' ? 'hf_saved' : undefined));
  parsers = new ToolCallParsers({ store, templates, savedToken });
});

describe('the parsers a person can pick', () => {
  it('are the rows stored', async () => {
    expect(await parsers.list()).toEqual([HERMES, MISTRAL, PYTHONIC]);
  });
});

describe('the parser chosen for a model', () => {
  it('is read from its chat template, with the token given, else the person\'s saved one', async () => {
    expect(await parsers.pick('Qwen/Qwen3-8B', { ownerId: 'ann', token: ' hf_given ' })).toEqual({ parser: 'hermes', from: 'template' });
    expect(templates.read).toHaveBeenLastCalledWith('Qwen/Qwen3-8B', 'hf_given');
    expect(await parsers.pick('Qwen/Qwen3-8B', { ownerId: 'ann' })).toEqual({ parser: 'hermes', from: 'template' });
    expect(templates.read).toHaveBeenLastCalledWith('Qwen/Qwen3-8B', 'hf_saved');
    await parsers.pick('Qwen/Qwen3-8B', { ownerId: 'bob' });
    expect(templates.read).toHaveBeenLastCalledWith('Qwen/Qwen3-8B', undefined);
  });

  it('says what Hugging Face said when the template cannot be shown', async () => {
    templates.read.calledWith('meta-llama/Gated', undefined).mockResolvedValue({ problem: 'gated' });
    expect(await parsers.pick('meta-llama/Gated', { ownerId: 'bob' })).toEqual({ problem: 'gated' });
  });
});

describe('a vLLM app\'s tool calling', () => {
  it('is on for a new app, its parser chosen from the model\'s chat template', async () => {
    expect(await parsers.decide({ vllmModel: 'Qwen/Qwen3-8B' }, { newApp: true, ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
  });

  it('reads the template with the app\'s own token before the saved one', async () => {
    await parsers.decide({ vllmModel: 'Qwen/Qwen3-8B', vllmHfToken: 'hf_app' }, { newApp: true, ownerId: 'ann' });
    expect(templates.read).toHaveBeenLastCalledWith('Qwen/Qwen3-8B', 'hf_app');
  });

  it('keeps the parser the person picked, without reading the template', async () => {
    expect(await parsers.decide({ vllmModel: 'Qwen/Qwen3-8B', vllmToolCallingEnabled: true, vllmToolCallParser: 'pythonic' }, { newApp: true, ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'pythonic' });
    expect(templates.read).not.toHaveBeenCalled();
  });

  it('stays off when the person turned it off, and an app deployed before it was on by default stays as it was', async () => {
    expect(await parsers.decide({ vllmModel: 'Qwen/Qwen3-8B', vllmToolCallingEnabled: false }, { newApp: true, ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: false });
    expect(await parsers.decide({ vllmModel: 'Qwen/Qwen3-8B' }, { newApp: false, ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: false });
    expect(templates.read).not.toHaveBeenCalled();
  });

  it('is refused on a model whose template has no format Koala knows, asking to pick one', async () => {
    expect(await parsers.decide({ vllmModel: 'someone/their-own-model' }, { newApp: true, ownerId: 'ann' })).toEqual({
      problem: 'someone/their-own-model\'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off',
    });
  });

  it('refuses a parser Koala does not know, and a model it is not told', async () => {
    expect(await parsers.decide({ vllmModel: 'Qwen/Qwen3-8B', vllmToolCallingEnabled: true, vllmToolCallParser: 'made-up' }, { newApp: true, ownerId: 'ann' })).toEqual({ problem: 'made-up is not a tool call parser Koala knows' });
    expect(await parsers.decide({ vllmToolCallingEnabled: true }, { newApp: true, ownerId: 'ann' })).toEqual({ problem: 'Say which model vLLM serves' });
  });
});

describe('a change to a vLLM app\'s settings', () => {
  const app = { appType: 'vllm', vllmModel: 'Qwen/Qwen3-8B', vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' };

  it('decides nothing when it leaves tool calling and the model alone, or for another app', async () => {
    expect(await parsers.change(app, {}, { ownerId: 'ann' })).toBeUndefined();
    expect(await parsers.change({ ...app, appType: 'tabbyapi' }, { vllmToolCallingEnabled: true }, { ownerId: 'ann' })).toBeUndefined();
  });

  it('keeps the parser picked before when the model changes, and chooses it from the new model when none is picked', async () => {
    expect(await parsers.change(app, { vllmModel: 'mistralai/Mistral-7B-Instruct-v0.3' }, { ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
    expect(await parsers.change(app, { vllmModel: 'mistralai/Mistral-7B-Instruct-v0.3', vllmToolCallParser: '' }, { ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'mistral' });
  });

  it('turns tool calling on for an app served without it, choosing the parser from its model', async () => {
    expect(await parsers.change({ appType: 'vllm', vllmModel: 'Qwen/Qwen3-8B' }, { vllmToolCallingEnabled: true }, { ownerId: 'ann' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
  });
});
