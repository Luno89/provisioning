import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parserFor, parserProblem, seedChanges, toolCallParsersFrom, type ToolCallParser } from './tool-call-parsers.js';
import { chatTemplateFixture } from '../testing/chat-templates.js';

const SEED = JSON.parse(readFileSync(new URL('../../../assets/tool-call-parsers.json', import.meta.url), 'utf8')) as unknown;
const shipped = toolCallParsersFrom(SEED);

const VLLM_V0_32_0_PARSERS = [
  'dots', 'deepseek_v3', 'deepseek_v31', 'deepseek_v32', 'deepseek_v4', 'deepseek_v41', 'cohere_command3', 'cohere_command4', 'ernie45',
  'glm45', 'glm47', 'ling3', 'granite-20b-fc', 'granite', 'granite4', 'hermes', 'hf', 'poolside_v1', 'hunyuan_a13b', 'hy_v3', 'hy_v4',
  'internlm', 'jamba', 'lfm2', 'kimi_k2', 'kimi_k3', 'k2_horizon', 'llama3_json', 'llama4_json', 'llama4_pythonic', 'longcat', 'mimo',
  'minimax_m2', 'minimax_m3', 'minicpm5', 'mistral', 'olmo3', 'plamo3', 'muse_glimmer', 'openai', 'phi4_mini_json', 'pythonic',
  'qwen3_coder', 'qwen3_json', 'qwen3_xml', 'seed_oss', 'step3', 'step3p5', 'inkling', 'xlam', 'gigachat3', 'functiongemma', 'gemma4', 'apertus',
];

const row = (parser: string, over: Partial<ToolCallParser> = {}): ToolCallParser => ({ parser, label: parser, template: [], names: [], shipped: true, ...over });

const FROM_TEMPLATES: [string, string][] = [
  ['Qwen/Qwen2.5-0.5B-Instruct', 'hermes'],
  ['Qwen/QwQ-32B', 'hermes'],
  ['Qwen/Qwen3-8B', 'hermes'],
  ['NousResearch/Hermes-3-Llama-3.1-8B', 'hermes'],
  ['NousResearch/Hermes-2-Pro-Llama-3-8B', 'hermes'],
  ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen3_xml'],
  ['Qwen/Qwen3.5-9B', 'qwen3_coder'],
  ['Qwen/Qwen3.6-27B', 'qwen3_coder'],
  ['meta-llama/Llama-3.1-8B-Instruct', 'llama3_json'],
  ['meta-llama/Llama-3.2-3B-Instruct', 'llama3_json'],
  ['meta-llama/Llama-3.3-70B-Instruct', 'llama3_json'],
  ['meta-llama/Llama-4-Scout-17B-16E-Instruct', 'llama4_pythonic'],
  ['mistralai/Mistral-7B-Instruct-v0.3', 'mistral'],
  ['ibm-granite/granite-4.0-h-tiny', 'granite4'],
  ['ibm-granite/granite-3.1-8b-instruct', 'granite'],
  ['openai/gpt-oss-20b', 'openai'],
  ['moonshotai/Kimi-K2-Instruct', 'kimi_k2'],
  ['tencent/Hunyuan-A13B-Instruct-FP8', 'hunyuan_a13b'],
  ['zai-org/GLM-4.5', 'glm45'],
  ['zai-org/GLM-4.7', 'glm47'],
  ['allenai/Olmo-3-7B-Instruct', 'olmo3'],
  ['stepfun-ai/Step-3.5-Flash', 'step3p5'],
  ['meituan-longcat/LongCat-Flash-Chat', 'longcat'],
  ['XiaomiMiMo/MiMo-V2-Flash', 'mimo'],
  ['ai-sage/GigaChat3-10B-A1.8B', 'gigachat3'],
  ['deepseek-ai/DeepSeek-V3-0324', 'deepseek_v3'],
  ['deepseek-ai/DeepSeek-V3.1', 'deepseek_v31'],
  ['Salesforce/Llama-xLAM-2-8b-fc-r', 'xlam'],
  ['google/gemma-4-31b-it', 'gemma4'],
  ['MiniMaxAI/MiniMax-M2', 'minimax_m2'],
  ['ByteDance-Seed/Seed-OSS-36B-Instruct', 'seed_oss'],
  ['baidu/ERNIE-4.5-21B-A3B-Thinking', 'ernie45'],
  ['LiquidAI/LFM2-1.2B', 'lfm2'],
  ['swiss-ai/Apertus-8B-Instruct-2509', 'apertus'],
  ['stepfun-ai/step3', 'step3'],
];

describe('the tool call parsers Koala ships', () => {
  it('are every parser vLLM v0.32.0 registers, each once, with a label', () => {
    expect(shipped.map((entry) => entry.parser).sort()).toEqual([...VLLM_V0_32_0_PARSERS].sort());
    expect(shipped.every((entry) => entry.label.length > 0 && entry.shipped)).toBe(true);
  });

  it.each(FROM_TEMPLATES)('choose for %s, from its real chat template, %s', (model, parser) => {
    expect(parserFor(shipped, { template: chatTemplateFixture(model) }, model)).toEqual({ parser, from: 'template' });
  });

  it.each(['mistralai/Mixtral-8x7B-Instruct-v0.1', 'internlm/internlm2_5-7b-chat'])('choose nothing for %s, whose chat template renders no tool calls', (model) => {
    expect(parserFor(shipped, { template: chatTemplateFixture(model) }, model)).toEqual({
      problem: `${model}'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off`,
    });
  });

  it('recognise each parser that has template markers in the real chat template of a model it serves', () => {
    const proved = new Set(FROM_TEMPLATES.map(([, parser]) => parser));
    expect(shipped.filter((entry) => entry.template.length > 0 && !proved.has(entry.parser)).map((entry) => entry.parser)).toEqual([]);
  });

  it('choose Mistral by its name for a Mistral model that ships no chat template', () => {
    expect(parserFor(shipped, { none: true }, 'mistralai/Mistral-Small-3.2-24B-Instruct-2506')).toEqual({ parser: 'mistral', from: 'name' });
  });

  it('choose hermes for a fine-tune named after nobody, since its template is hermes\'s', () => {
    expect(parserFor(shipped, { template: chatTemplateFixture('Qwen/Qwen3-8B') }, 'someone/their-own-model')).toEqual({ parser: 'hermes', from: 'template' });
  });
});

describe('choosing a parser from a chat template', () => {
  const xml = row('qwen3_coder', { template: [{ contains: '<function=' }] });
  const coder = row('qwen3_xml', { template: [{ contains: '<function=' }], names: ['(^|/)qwen3-coder-'] });
  const step = row('step3p5', { template: [{ contains: '<function=' }], names: ['(^|/)step-3\\.5-'] });
  const json = row('hermes', { template: [{ contains: '<tool_call>' }, { matches: '"name": <[a-z-]+>' }] });

  it('takes the one parser whose every marker the template holds', () => {
    expect(parserFor([json, xml], { template: '<tool_call> {"name": <function-name>}' }, 'a/b')).toEqual({ parser: 'hermes', from: 'template' });
    expect(parserFor([json], { template: '<tool_call> only' }, 'a/b')).toEqual({ problem: 'a/b\'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off' });
  });

  it('takes the one parser whose every marker the template holds even when its names do not fit the model', () => {
    expect(parserFor([coder], { template: '<function=x>' }, 'someone/fine-tune')).toEqual({ parser: 'qwen3_xml', from: 'template' });
  });

  it('lets the model\'s name decide between parsers the template fits, and a parser without names otherwise', () => {
    expect(parserFor([xml, coder, step], { template: '<function=x>' }, 'Qwen/Qwen3-Coder-30B-A3B-Instruct')).toEqual({ parser: 'qwen3_xml', from: 'template' });
    expect(parserFor([xml, coder, step], { template: '<function=x>' }, 'stepfun-ai/Step-3.5-Flash')).toEqual({ parser: 'step3p5', from: 'template' });
    expect(parserFor([xml, coder, step], { template: '<function=x>' }, 'Qwen/Qwen3.5-9B')).toEqual({ parser: 'qwen3_coder', from: 'template' });
  });

  it('refuses to guess between parsers the template and the name fit alike', () => {
    expect(parserFor([coder, step], { template: '<function=x>' }, 'someone/fine-tune')).toEqual({
      problem: 'someone/fine-tune\'s chat template fits more than one tool call parser (qwen3_xml, step3p5): pick one, or turn tool calling off',
    });
  });

  it('chooses by name alone only when the model ships no chat template, and refuses when no name fits', () => {
    expect(parserFor([xml, coder], { none: true }, 'Qwen/Qwen3-Coder-Next')).toEqual({ parser: 'qwen3_xml', from: 'name' });
    expect(parserFor([xml, coder], { none: true }, 'someone/fine-tune')).toEqual({
      problem: 'someone/fine-tune has no chat template on Hugging Face, and its name fits no tool call parser Koala knows: pick a parser, or turn tool calling off',
    });
    expect(parserFor([xml, coder], { template: 'nothing about tools' }, 'Qwen/Qwen3-Coder-Next')).toEqual({ problem: 'Qwen/Qwen3-Coder-Next\'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off' });
  });
});

describe('a parser the person picked', () => {
  it('is taken when Koala knows it, and refused saying so otherwise', () => {
    expect(parserProblem(shipped, 'pythonic')).toBeUndefined();
    expect(parserProblem(shipped, 'made-up')).toBe('made-up is not a tool call parser Koala knows');
  });
});

describe('reading the parsers to seed', () => {
  it('refuses a row whose marker or name is not a pattern Koala runs, naming it', () => {
    expect(() => toolCallParsersFrom({ parsers: [{ parser: 'a', label: 'A', template: [{ matches: '(?=x)' }] }] })).toThrow(/a: the template marker \(\?=x\) is not an RE2 pattern/);
    expect(() => toolCallParsersFrom({ parsers: [{ parser: 'a', label: 'A', names: ['(?<=x)'] }] })).toThrow(/a: the name \(\?<=x\) is not an RE2 pattern/);
  });

  it('refuses a row with no name or label, a parser named twice, and a marker that is neither a substring nor a pattern', () => {
    expect(() => toolCallParsersFrom({ parsers: [{ label: 'A' }] })).toThrow(/a parser has no name/);
    expect(() => toolCallParsersFrom({ parsers: [{ parser: 'a' }] })).toThrow(/a: it has no label/);
    expect(() => toolCallParsersFrom({ parsers: [{ parser: 'a', label: 'A' }, { parser: 'a', label: 'B' }] })).toThrow(/a is named twice/);
    expect(() => toolCallParsersFrom({ parsers: [{ parser: 'a', label: 'A', template: [{ near: 'x' }] }] })).toThrow(/a: a template marker is a substring \(contains\) or a pattern \(matches\)/);
    expect(() => toolCallParsersFrom({})).toThrow(/no parsers/);
  });
});

describe('what seeding changes', () => {
  it('writes a shipped row that is new or differs, removes one no longer shipped, and keeps every row added another way', () => {
    const stored = [row('hermes', { label: 'old' }), row('gone'), row('mine', { shipped: false }), row('same'), row('ours', { shipped: false, label: 'Ours' })];
    const wanted = [row('hermes', { label: 'Hermes' }), row('same'), row('new'), row('ours')];
    expect(seedChanges(stored, wanted)).toEqual({ save: [row('hermes', { label: 'Hermes' }), row('new')], remove: ['gone'] });
    expect(seedChanges(wanted, wanted)).toEqual({ save: [], remove: [] });
  });
});
