import { describe, expect, it } from 'vitest';
import { chatTemplateIn, modelIdProblem } from './chat-templates.js';

describe('the chat template in a file a model ships', () => {
  it('is the whole of chat_template.jinja', () => {
    expect(chatTemplateIn('chat_template.jinja', '{{ messages }}')).toEqual({ template: '{{ messages }}' });
    expect(chatTemplateIn('chat_template.jinja', '  ')).toEqual({ none: true });
  });

  it('is tokenizer_config.json\'s chat_template, the one for tools when it names several', () => {
    expect(chatTemplateIn('tokenizer_config.json', JSON.stringify({ chat_template: '{{ a }}' }))).toEqual({ template: '{{ a }}' });
    expect(chatTemplateIn('tokenizer_config.json', JSON.stringify({ chat_template: [{ name: 'default', template: '{{ d }}' }, { name: 'tool_use', template: '{{ t }}' }] }))).toEqual({ template: '{{ t }}' });
    expect(chatTemplateIn('tokenizer_config.json', JSON.stringify({ chat_template: [{ name: 'default', template: '{{ d }}' }, { name: 'rag', template: '{{ r }}' }] }))).toEqual({ template: '{{ d }}' });
    expect(chatTemplateIn('tokenizer_config.json', JSON.stringify({ model_max_length: 4096 }))).toEqual({ none: true });
  });

  it('is chat_template.json\'s chat_template', () => {
    expect(chatTemplateIn('chat_template.json', JSON.stringify({ chat_template: '{{ p }}' }))).toEqual({ template: '{{ p }}' });
  });

  it('cannot be read from a file that is not the JSON it should be, or names templates but none for tools or by default', () => {
    expect(chatTemplateIn('tokenizer_config.json', '<html>')).toEqual({ unreadable: 'tokenizer_config.json is not JSON' });
    expect(chatTemplateIn('tokenizer_config.json', JSON.stringify({ chat_template: [{ name: 'rag', template: 'x' }] }))).toEqual({ unreadable: 'tokenizer_config.json names chat templates (rag), none of them tool_use or default' });
    expect(chatTemplateIn('tokenizer_config.json', JSON.stringify({ chat_template: 42 }))).toEqual({ unreadable: 'tokenizer_config.json\'s chat_template is neither text nor a list of named templates' });
  });
});

describe('a model Koala reads a chat template for', () => {
  it('is named as Hugging Face names it, an owner and a name', () => {
    expect(modelIdProblem('Qwen/Qwen2.5-0.5B-Instruct')).toBeUndefined();
    expect(modelIdProblem('ai-sage/GigaChat3-10B-A1.8B')).toBeUndefined();
    expect(modelIdProblem('')).toBe('Say which model vLLM serves');
    for (const bad of ['qwen', '../etc/passwd', 'a/b/c', 'a/../b', 'a b/c']) expect(modelIdProblem(bad)).toBe(`${bad} is not a Hugging Face model: name it as owner/model`);
  });
});
