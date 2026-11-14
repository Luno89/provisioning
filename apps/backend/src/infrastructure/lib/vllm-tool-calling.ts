export const VLLM_TOOL_CALL_PARSERS = [
  'hermes', 'mistral', 'granite4', 'granite', 'granite-20b-fc', 'llama3_json', 'llama4_pythonic', 'pythonic',
  'internlm', 'jamba', 'xlam', 'deepseek_v3', 'deepseek_v31', 'openai', 'kimi_k2', 'hunyuan_a13b',
  'cohere_command3', 'cohere_command4', 'longcat', 'glm45', 'glm47', 'functiongemma', 'qwen3_xml', 'qwen3_coder', 'mimo',
  'step3p5', 'olmo3', 'gigachat3', 'apertus', 'hf',
] as const;

export type VllmToolCallParser = typeof VLLM_TOOL_CALL_PARSERS[number];

const FAMILIES: readonly { name: RegExp; org?: RegExp; parser: VllmToolCallParser }[] = [
  { name: /^qwen3-coder-/, parser: 'qwen3_xml' },
  { name: /^qwen3\.[56]-/, parser: 'qwen3_coder' },
  { name: /^(qwen2\.5-|qwq-|qwen3-)/, parser: 'hermes' },
  { name: /^hermes-(2-pro|3)-/, parser: 'hermes' },
  { name: /^(mistral|mixtral)-/, parser: 'mistral' },
  { name: /./, org: /^mistralai$/, parser: 'mistral' },
  { name: /^granite-4\.0-/, parser: 'granite4' },
  { name: /^granite-3\.1-/, parser: 'granite' },
  { name: /^(meta-)?llama-3\.[123]-/, parser: 'llama3_json' },
  { name: /^ai21-jamba-1\.5-/, parser: 'jamba' },
  { name: /^gpt-oss-/, parser: 'openai' },
  { name: /^kimi-k2-/, parser: 'kimi_k2' },
  { name: /^hunyuan-a13b-/, parser: 'hunyuan_a13b' },
  { name: /^glm-4\.[56]($|-)/, parser: 'glm45' },
  { name: /^glm-4\.7($|-)/, parser: 'glm47' },
  { name: /^olmo-3-/, parser: 'olmo3' },
  { name: /^step-3\.[57]-flash/, parser: 'step3p5' },
  { name: /^longcat-flash-chat/, parser: 'longcat' },
  { name: /^mimo-v2\.6-/, parser: 'mimo' },
  { name: /^gigachat3-/, parser: 'gigachat3' },
];

export function toolCallParserFor(model: string | undefined): VllmToolCallParser | undefined {
  const parts = (model ?? '').trim().toLowerCase().split('/');
  const name = parts.at(-1) ?? '';
  const org = parts.length > 1 ? parts[0]! : '';
  if (!name) return undefined;
  return FAMILIES.find((family) => family.name.test(name) && (!family.org || family.org.test(org)))?.parser;
}

const isParser = (value: string): value is VllmToolCallParser => (VLLM_TOOL_CALL_PARSERS as readonly string[]).includes(value);

export interface VllmToolCallingAsked {
  vllmModel?: string | undefined;
  vllmToolCallingEnabled?: boolean | undefined;
  vllmToolCallParser?: string | undefined;
}

export type VllmToolCalling =
  | { vllmToolCallingEnabled: false }
  | { vllmToolCallingEnabled: true; vllmToolCallParser: VllmToolCallParser }
  | { problem: string };

export function vllmToolCalling(app: VllmToolCallingAsked, { newApp }: { newApp: boolean }): VllmToolCalling {
  const enabled = app.vllmToolCallingEnabled ?? newApp;
  if (!enabled) return { vllmToolCallingEnabled: false };
  const picked = app.vllmToolCallParser || undefined;
  if (picked !== undefined && !isParser(picked)) return { problem: `${picked} is not a tool call parser vLLM v0.32.0 has` };
  const parser = picked !== undefined && isParser(picked) ? picked : toolCallParserFor(app.vllmModel);
  if (!parser) return { problem: `Koala cannot tell which tool call parser vLLM needs for ${app.vllmModel || 'this model'}: pick one, or turn tool calling off` };
  return { vllmToolCallingEnabled: true, vllmToolCallParser: parser };
}

const TOOL_FIELDS = ['vllmModel', 'vllmToolCallingEnabled', 'vllmToolCallParser'] as const;

export function vllmToolCallingChange(current: VllmToolCallingAsked & { appType?: string | undefined }, patch: VllmToolCallingAsked): VllmToolCalling | undefined {
  if (current.appType !== 'vllm' || !TOOL_FIELDS.some((field) => field in patch)) return undefined;
  return vllmToolCalling({ ...current, ...patch }, { newApp: false });
}
