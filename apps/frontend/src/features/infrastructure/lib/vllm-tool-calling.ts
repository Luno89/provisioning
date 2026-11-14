/*
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: apps/backend/src/infrastructure/lib/vllm-tool-calling.ts (VLLM_TOOL_CALL_PARSERS,
 * toolCallParserFor), which decides every deploy and settings change. The wizard and an app's
 * settings show the same choice as the person types, before anything is sent.
 */
export const VLLM_TOOL_CALL_PARSERS: readonly { parser: string; label: string }[] = [
  { parser: 'hermes', label: 'Hermes, Qwen 2.5, QwQ, Qwen 3' },
  { parser: 'qwen3_xml', label: 'Qwen3-Coder' },
  { parser: 'qwen3_coder', label: 'Qwen 3.5, 3.6' },
  { parser: 'llama3_json', label: 'Llama 3.1, 3.2, 3.3' },
  { parser: 'llama4_pythonic', label: 'Llama 4' },
  { parser: 'pythonic', label: 'Pythonic (Llama 3.2 small, ToolACE)' },
  { parser: 'mistral', label: 'Mistral' },
  { parser: 'granite4', label: 'Granite 4.0' },
  { parser: 'granite', label: 'Granite 3' },
  { parser: 'granite-20b-fc', label: 'Granite 20B Function Calling' },
  { parser: 'internlm', label: 'InternLM 2.5' },
  { parser: 'jamba', label: 'Jamba 1.5' },
  { parser: 'xlam', label: 'xLAM' },
  { parser: 'deepseek_v3', label: 'DeepSeek V3, R1' },
  { parser: 'deepseek_v31', label: 'DeepSeek V3.1' },
  { parser: 'openai', label: 'gpt-oss' },
  { parser: 'kimi_k2', label: 'Kimi K2' },
  { parser: 'hunyuan_a13b', label: 'Hunyuan A13B' },
  { parser: 'cohere_command3', label: 'Command A Reasoning' },
  { parser: 'cohere_command4', label: 'Command A Plus' },
  { parser: 'longcat', label: 'LongCat Flash' },
  { parser: 'glm45', label: 'GLM 4.5, 4.6' },
  { parser: 'glm47', label: 'GLM 4.7' },
  { parser: 'functiongemma', label: 'FunctionGemma' },
  { parser: 'mimo', label: 'MiMo' },
  { parser: 'step3p5', label: 'Step 3.5' },
  { parser: 'olmo3', label: 'Olmo 3' },
  { parser: 'gigachat3', label: 'GigaChat 3' },
  { parser: 'apertus', label: 'Apertus' },
  { parser: 'hf', label: 'The model\'s own response template' },
]

const FAMILIES: readonly { name: RegExp; org?: RegExp; parser: string }[] = [
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
]

export function toolCallParserFor(model: string): string | undefined {
  const parts = model.trim().toLowerCase().split('/')
  const name = parts.at(-1) ?? ''
  const org = parts.length > 1 ? parts[0]! : ''
  if (!name) return undefined
  return FAMILIES.find((family) => family.name.test(name) && (!family.org || family.org.test(org)))?.parser
}

export type ToolCalling =
  | { enabled: false }
  | { enabled: true; parser: string; fromModel?: string }
  | { enabled: true; problem: string }

export function toolCallingOf(model: string, enabled: boolean, picked: string): ToolCalling {
  if (!enabled) return { enabled: false }
  const fromModel = toolCallParserFor(model)
  const parser = picked || fromModel
  if (!parser) return { enabled: true, problem: `Koala cannot tell which tool call parser ${model.trim() || 'this model'} needs: pick one, or turn tool calling off.` }
  return { enabled: true, parser, ...(fromModel ? { fromModel } : {}) }
}
