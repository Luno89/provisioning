import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { chatTemplatesOverHttp, ChatTemplateUnread } from './ChatTemplates.js';

const HF = 'https://hf.test';
const hf = interceptHttp();
const templates = chatTemplatesOverHttp(HF);

describe('reading a model\'s chat template from Hugging Face', () => {
  it('reads chat_template.jinja first, sending the token it was given', async () => {
    const asked: [string, string | null][] = [];
    hf.use(http.get(`${HF}/Qwen/Qwen3.6-27B/resolve/main/:file`, ({ request, params }) => {
      asked.push([String(params.file), request.headers.get('authorization')]);
      return params.file === 'chat_template.jinja' ? new HttpResponse('{{ jinja }}') : new HttpResponse(null, { status: 404 });
    }));
    expect(await templates.read('Qwen/Qwen3.6-27B', 'hf_token')).toEqual({ template: '{{ jinja }}' });
    expect(asked).toEqual([['chat_template.jinja', 'Bearer hf_token']]);
  });

  it('goes on to tokenizer_config.json and then chat_template.json when the files before it are missing or hold none', async () => {
    hf.use(http.get(`${HF}/a/b/resolve/main/:file`, ({ params }) => {
      if (params.file === 'tokenizer_config.json') return HttpResponse.json({ model_max_length: 1 });
      if (params.file === 'chat_template.json') return HttpResponse.json({ chat_template: '{{ processor }}' });
      return new HttpResponse(null, { status: 404 });
    }));
    expect(await templates.read('a/b', undefined)).toEqual({ template: '{{ processor }}' });
    hf.use(http.get(`${HF}/a/c/resolve/main/:file`, ({ request, params }) => {
      expect(request.headers.get('authorization')).toBeNull();
      return params.file === 'tokenizer_config.json' ? HttpResponse.json({ chat_template: '{{ tokenizer }}' }) : new HttpResponse(null, { status: 404 });
    }));
    expect(await templates.read('a/c', undefined)).toEqual({ template: '{{ tokenizer }}' });
  });

  it('says a model ships none when no file holds one', async () => {
    hf.use(http.get(`${HF}/mistralai/Small/resolve/main/:file`, () => new HttpResponse(null, { status: 404 })));
    expect(await templates.read('mistralai/Small', undefined)).toEqual({ none: true });
  });

  it('says what to do when Hugging Face will not show the model, or a file cannot be read', async () => {
    hf.use(http.get(`${HF}/meta-llama/Gated/resolve/main/:file`, () => new HttpResponse(null, { status: 401 })));
    expect(await templates.read('meta-llama/Gated', undefined)).toEqual({ problem: 'Hugging Face would not show meta-llama/Gated\'s chat template (401): the model is gated or does not exist. Check its name, or give a Hugging Face token that may read it' });
    hf.use(http.get(`${HF}/a/broken/resolve/main/:file`, ({ params }) => (params.file === 'chat_template.jinja' ? new HttpResponse(null, { status: 404 }) : new HttpResponse('<html>'))));
    expect(await templates.read('a/broken', undefined)).toEqual({ problem: 'a/broken\'s chat template cannot be read: tokenizer_config.json is not JSON' });
    expect(await templates.read('not-a-model', undefined)).toEqual({ problem: 'not-a-model is not a Hugging Face model: name it as owner/model' });
  });

  it('fails, saying why, when Hugging Face does not answer, never taking that for a model without a template', async () => {
    hf.use(http.get(`${HF}/a/busy/resolve/main/:file`, () => new HttpResponse(null, { status: 503 })));
    const busy = templates.read('a/busy', undefined);
    await expect(busy).rejects.toBeInstanceOf(ChatTemplateUnread);
    await expect(busy).rejects.toMatchObject({ status: 502, message: 'Hugging Face did not answer for a/busy\'s chat template: it answered 503' });
    hf.use(http.get(`${HF}/a/down/resolve/main/:file`, () => HttpResponse.error()));
    const down = await templates.read('a/down', undefined).then(() => undefined, (err: unknown) => err);
    expect(down).toBeInstanceOf(ChatTemplateUnread);
    expect((down as ChatTemplateUnread).message).toMatch(/^Koala could not reach Hugging Face for a\/down's chat template: /);
  });
});
