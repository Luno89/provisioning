import { errorMessage } from '../../../api/client'
import { useToolCallParserPick } from '../../models'
import { toolCallingOf, type ToolCalling } from '../lib/vllm-tool-calling'

export function useVllmToolCalling(model: string, enabled: boolean, picked: string, hfToken: string): ToolCalling {
  const chosen = useToolCallParserPick(model, hfToken, enabled)
  return toolCallingOf(model, enabled, picked, { pick: chosen.data, error: chosen.error ? errorMessage(chosen.error) : undefined })
}
