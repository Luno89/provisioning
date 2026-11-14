import axios from 'axios';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptValue } from '../../platform/lib/crypto.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { startHuggingFaceStandIn, type HuggingFaceStandIn } from '../testing/hugging-face-stand-in.js';
import { chatTemplatesOverHttp } from '../services/ChatTemplates.js';
import { seedToolCallParsers } from '../services/tool-call-parser-seed.js';
import { ToolCallParsers } from '../services/ToolCallParsers.js';
import { toolCallParsersRouter } from './tool-call-parsers.js';
import { savedHuggingFaceTokenOf } from '../../infrastructure/index.js';

const KEY = 'test-key-that-is-at-least-32-characters-long';
const quiet = { validateStatus: () => true };

let hf: HuggingFaceStandIn;
let site: Harness;

beforeAll(async () => {
  hf = await startHuggingFaceStandIn({
    'Qwen/Qwen2.5-0.5B-Instruct': { fixture: 'Qwen/Qwen2.5-0.5B-Instruct', as: 'tokenizer_config.json' },
    'meta-llama/Llama-3.2-3B-Instruct': { fixture: 'meta-llama/Llama-3.2-3B-Instruct', needsToken: 'hf_saved' },
    'someone/busy': { answers: 500 },
  });
  site = await mountRouter({
    prefix: '/api/tool-call-parsers',
    db: 'own',
    router: async (db) => {
      await seedToolCallParsers(db.models);
      await db.accounts.saveUser({ id: TEST_USER.id, email: TEST_USER.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { huggingface: { hfToken: encryptValue('hf_saved', KEY) } } } as never);
      const parsers = new ToolCallParsers({
        store: db.models,
        templates: chatTemplatesOverHttp(hf.url),
        savedToken: savedHuggingFaceTokenOf(db.accounts, KEY),
      });
      return toolCallParsersRouter({ parsers });
    },
  });
});

afterAll(async () => {
  await site.close();
  await hf.close();
});

describe('the tool call parser routes, on the seeded parsers and a Hugging Face over HTTP', () => {
  it('list every parser Koala seeded', async () => {
    const { data } = await axios.get<{ parser: string; label: string }[]>(site.url('/api/tool-call-parsers'));
    expect(data).toHaveLength(54);
    expect(data).toContainEqual({ parser: 'hermes', label: 'Hermes, Qwen 2.5, QwQ, Qwen 3' });
  });

  it('pick from the model\'s chat template, reading a gated one with the person\'s saved token', async () => {
    expect((await axios.post(site.url('/api/tool-call-parsers/pick'), { model: 'Qwen/Qwen2.5-0.5B-Instruct' })).data).toEqual({ parser: 'hermes', from: 'template' });
    expect((await axios.post(site.url('/api/tool-call-parsers/pick'), { model: 'meta-llama/Llama-3.2-3B-Instruct' })).data).toEqual({ parser: 'llama3_json', from: 'template' });
    expect((await axios.post(site.url('/api/tool-call-parsers/pick'), { model: 'meta-llama/Llama-3.2-3B-Instruct', hfToken: 'hf_wrong' })).data).toEqual({ problem: 'Hugging Face would not show meta-llama/Llama-3.2-3B-Instruct\'s chat template (401): the model is gated or does not exist. Check its name, or give a Hugging Face token that may read it' });
  });

  it('answer 502 with why when Hugging Face fails', async () => {
    const answer = await axios.post(site.url('/api/tool-call-parsers/pick'), { model: 'someone/busy' }, quiet);
    expect(answer.status).toBe(502);
    expect(answer.data).toEqual({ error: 'Hugging Face did not answer for someone/busy\'s chat template: it answered 500' });
  });
});
