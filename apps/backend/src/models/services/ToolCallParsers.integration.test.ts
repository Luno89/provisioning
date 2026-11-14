import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { startHuggingFaceStandIn, type HuggingFaceStandIn } from '../testing/hugging-face-stand-in.js';
import { chatTemplatesOverHttp, ChatTemplateUnread } from './ChatTemplates.js';
import { seedToolCallParsers } from './tool-call-parser-seed.js';
import { ToolCallParsers } from './ToolCallParsers.js';

let hf: HuggingFaceStandIn;
let db: Database;
let parsers: ToolCallParsers;

beforeAll(async () => {
  hf = await startHuggingFaceStandIn({
    'Qwen/Qwen2.5-0.5B-Instruct': { fixture: 'Qwen/Qwen2.5-0.5B-Instruct', as: 'tokenizer_config.json' },
    'Qwen/Qwen3.6-27B': { fixture: 'Qwen/Qwen3.6-27B' },
    'Qwen/Qwen3-Coder-30B-A3B-Instruct': { fixture: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' },
    'meta-llama/Llama-3.2-3B-Instruct': { fixture: 'meta-llama/Llama-3.2-3B-Instruct', needsToken: 'hf_llama' },
    'mistralai/Mistral-Small-3.2-24B-Instruct-2506': {},
    'mistralai/Mixtral-8x7B-Instruct-v0.1': { fixture: 'mistralai/Mixtral-8x7B-Instruct-v0.1', as: 'tokenizer_config.json' },
    'someone/busy': { answers: 503 },
  });
  db = await testDatabase();
  await seedToolCallParsers(db.models);
  parsers = new ToolCallParsers({
    store: db.models,
    templates: chatTemplatesOverHttp(hf.url),
    savedToken: async (ownerId) => (ownerId === 'ann' ? 'hf_llama' : undefined),
  });
});

afterAll(async () => {
  await hf.close();
});

describe('the parser Koala picks, from the seeded parsers and a chat template read over HTTP', () => {
  it.each([
    ['Qwen/Qwen2.5-0.5B-Instruct', 'hermes'],
    ['Qwen/Qwen3.6-27B', 'qwen3_coder'],
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen3_xml'],
  ])('is, for %s, %s', async (model, parser) => {
    expect(await parsers.pick(model, { ownerId: 'bob' })).toEqual({ parser, from: 'template' });
  });

  it('reads a gated model\'s template with the person\'s saved token, and says it is gated to someone without one', async () => {
    expect(await parsers.pick('meta-llama/Llama-3.2-3B-Instruct', { ownerId: 'ann' })).toEqual({ parser: 'llama3_json', from: 'template' });
    expect(hf.asked.filter((ask) => ask.path.startsWith('/meta-llama/')).every((ask) => ask.token === 'hf_llama')).toBe(true);
    expect(await parsers.pick('meta-llama/Llama-3.2-3B-Instruct', { ownerId: 'bob' })).toEqual({
      problem: 'Hugging Face would not show meta-llama/Llama-3.2-3B-Instruct\'s chat template (401): the model is gated or does not exist. Check its name, or give a Hugging Face token that may read it',
    });
  });

  it('picks Mistral by name for a model that ships no template, and refuses a template with no tool calls in it', async () => {
    expect(await parsers.pick('mistralai/Mistral-Small-3.2-24B-Instruct-2506', { ownerId: 'bob' })).toEqual({ parser: 'mistral', from: 'name' });
    expect(await parsers.decide({ vllmModel: 'mistralai/Mixtral-8x7B-Instruct-v0.1' }, { newApp: true, ownerId: 'bob' })).toEqual({
      problem: 'mistralai/Mixtral-8x7B-Instruct-v0.1\'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off',
    });
  });

  it('fails with why when Hugging Face does not answer', async () => {
    await expect(parsers.decide({ vllmModel: 'someone/busy' }, { newApp: true, ownerId: 'bob' })).rejects.toBeInstanceOf(ChatTemplateUnread);
  });

  it('takes a parser the person added to the store, and refuses one nobody added', async () => {
    await db.models.saveToolCallParser({ parser: 'my-own', label: 'Mine', template: [], names: [], shipped: false });
    expect(await parsers.decide({ vllmModel: 'someone/busy', vllmToolCallingEnabled: true, vllmToolCallParser: 'my-own' }, { newApp: true, ownerId: 'bob' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'my-own' });
    expect(await parsers.decide({ vllmModel: 'someone/busy', vllmToolCallingEnabled: true, vllmToolCallParser: 'nobodys' }, { newApp: true, ownerId: 'bob' })).toEqual({ problem: 'nobodys is not a tool call parser Koala knows' });
  });
});
