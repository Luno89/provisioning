import { describe, expect, it } from 'vitest';
import { toolCallParserFor, vllmToolCalling, vllmToolCallingChange, VLLM_TOOL_CALL_PARSERS } from './vllm-tool-calling.js';

describe('vllmToolCallingChange', () => {
  const app = { appType: 'vllm', vllmModel: 'Qwen/Qwen3-8B', vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' };

  it('decides nothing for a change that leaves tool calling and the model alone, or for another app', () => {
    expect(vllmToolCallingChange(app, {})).toBeUndefined();
    expect(vllmToolCallingChange({ ...app, appType: 'tabbyapi' }, { vllmToolCallingEnabled: true })).toBeUndefined();
  });

  it('keeps the parser picked before when the model changes, and chooses it from the new model when none is picked', () => {
    expect(vllmToolCallingChange(app, { vllmModel: 'mistralai/Mistral-7B-Instruct-v0.3' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
    expect(vllmToolCallingChange(app, { vllmModel: 'mistralai/Mistral-7B-Instruct-v0.3', vllmToolCallParser: '' })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'mistral' });
  });

  it('turns tool calling on for an app served without it, choosing the parser from its model', () => {
    expect(vllmToolCallingChange({ appType: 'vllm', vllmModel: 'Qwen/Qwen3-8B' }, { vllmToolCallingEnabled: true })).toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
  });
});

describe('toolCallParserFor', () => {
  it.each([
    ['Qwen/Qwen2.5-0.5B-Instruct', 'hermes'],
    ['Qwen/QwQ-32B', 'hermes'],
    ['Qwen/Qwen3-8B', 'hermes'],
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen3_xml'],
    ['unsloth/Qwen2.5-7B-Instruct', 'hermes'],
    ['NousResearch/Hermes-3-Llama-3.1-8B', 'hermes'],
    ['NousResearch/Hermes-2-Pro-Mistral-7B', 'hermes'],
    ['meta-llama/Llama-3.2-3B-Instruct', 'llama3_json'],
    ['meta-llama/Llama-3.1-8B-Instruct', 'llama3_json'],
    ['meta-llama/Meta-Llama-3.1-70B-Instruct', 'llama3_json'],
    ['mistralai/Mistral-7B-Instruct-v0.3', 'mistral'],
    ['ibm-granite/granite-4.0-h-small', 'granite4'],
    ['ibm-granite/granite-3.1-8b-instruct', 'granite'],
    ['ai21labs/AI21-Jamba-1.5-Mini', 'jamba'],
    ['openai/gpt-oss-20b', 'openai'],
    ['moonshotai/Kimi-K2-Instruct', 'kimi_k2'],
    ['tencent/Hunyuan-A13B-Instruct', 'hunyuan_a13b'],
    ['zai-org/GLM-4.5-Air', 'glm45'],
    ['zai-org/GLM-4.6', 'glm45'],
    ['zai-org/GLM-4.7-Flash', 'glm47'],
    ['allenai/Olmo-3-7B-Instruct', 'olmo3'],
  ])('%s is served with %s', (model, parser) => {
    expect(toolCallParserFor(model)).toBe(parser);
  });

  it.each([
    'NousResearch/Hermes-2-Theta-Llama-3-8B',
    'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    'ibm-granite/granite-3.0-8b-instruct',
    'deepseek-ai/DeepSeek-V3.1',
    'someone/their-own-model',
    '',
  ])('%s gets no parser chosen', (model) => {
    expect(toolCallParserFor(model)).toBeUndefined();
  });

  it('chooses only parsers vLLM has', () => {
    for (const model of ['Qwen/Qwen3-8B', 'mistralai/Mistral-7B-Instruct-v0.3', 'zai-org/GLM-4.7']) {
      expect(VLLM_TOOL_CALL_PARSERS).toContain(toolCallParserFor(model));
    }
  });
});

describe('vllmToolCalling', () => {
  it('turns tool calling on for a new app and chooses the parser from its model', () => {
    expect(vllmToolCalling({ vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct' }, { newApp: true }))
      .toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
  });

  it('keeps the parser the person picked', () => {
    expect(vllmToolCalling({ vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct', vllmToolCallingEnabled: true, vllmToolCallParser: 'pythonic' }, { newApp: true }))
      .toEqual({ vllmToolCallingEnabled: true, vllmToolCallParser: 'pythonic' });
  });

  it('leaves tool calling off when the person turned it off', () => {
    expect(vllmToolCalling({ vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct', vllmToolCallingEnabled: false }, { newApp: true }))
      .toEqual({ vllmToolCallingEnabled: false });
  });

  it('leaves an app deployed before tool calling was on by default as it was', () => {
    expect(vllmToolCalling({ vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct' }, { newApp: false }))
      .toEqual({ vllmToolCallingEnabled: false });
  });

  it('refuses tool calling on a model whose parser it does not know, asking the person to pick one', () => {
    expect(vllmToolCalling({ vllmModel: 'someone/their-own-model' }, { newApp: true })).toEqual({
      problem: 'Koala cannot tell which tool call parser vLLM needs for someone/their-own-model: pick one, or turn tool calling off',
    });
  });

  it('refuses a parser vLLM does not have', () => {
    expect(vllmToolCalling({ vllmModel: 'Qwen/Qwen3-8B', vllmToolCallingEnabled: true, vllmToolCallParser: 'made-up' }, { newApp: true }))
      .toEqual({ problem: 'made-up is not a tool call parser vLLM v0.32.0 has' });
  });
});

describe('the tool call parser Koala picks from a model\'s name', () => {
  it.each([
    ['Qwen/Qwen3-8B', 'hermes'],
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen3_xml'],
    ['Qwen/Qwen3.5-9B', 'qwen3_coder'],
    ['Qwen/Qwen3.6-35B-A3B', 'qwen3_coder'],
    ['Qwen/Qwen3.6-27B', 'qwen3_coder'],
  ])('is %s → %s, as vLLM v0.32.0\'s own recipes serve it', (model, parser) => {
    expect(toolCallParserFor(model)).toBe(parser);
  });
});
