import type { ToolCallParserPick } from '../../models'

export type ToolCalling =
  | { enabled: false }
  | { enabled: true; parser: string; fromModel?: string }
  | { enabled: true; problem: string }
  | { enabled: true; waiting: string }

export interface ChosenFromModel {
  pick?: ToolCallParserPick | undefined
  error?: string | undefined
}

const HOW: Record<'template' | 'name', string> = { template: 'its chat template', name: 'its name' }

export function toolCallingOf(model: string, enabled: boolean, picked: string, chosen: ChosenFromModel): ToolCalling {
  if (!enabled) return { enabled: false }
  const fromModel = chosen.pick && 'parser' in chosen.pick ? `Chosen from ${HOW[chosen.pick.from]}: ${chosen.pick.parser}` : undefined
  if (picked) return { enabled: true, parser: picked, ...(fromModel ? { fromModel } : {}) }
  if (chosen.pick && 'parser' in chosen.pick) return { enabled: true, parser: chosen.pick.parser, fromModel: fromModel! }
  if (chosen.pick) return { enabled: true, problem: chosen.pick.problem }
  if (chosen.error) return { enabled: true, problem: chosen.error }
  if (!model.trim()) return { enabled: true, problem: 'Type the model, so Koala can read its chat template' }
  return { enabled: true, waiting: `Koala is reading ${model.trim()}'s chat template to choose its parser` }
}

export const toolCallingBlocks = (calling: ToolCalling): boolean => 'problem' in calling || 'waiting' in calling
