import type { Scenario } from '../api/evals'

export type CheckLevel = 'step' | 'turn' | 'run' | 'flow'
export type CheckModel = 'yours' | 'script' | 'none'

export interface CheckKind {
  level: CheckLevel
  model: CheckModel
}

const MODEL_NODES = ['decide', 'call-model', 'compact-context']

export function checkKind(scenario: Pick<Scenario, 'step' | 'turn' | 'then' | 'script'>): CheckKind {
  const level: CheckLevel = scenario.step ? 'step' : scenario.turn ? 'turn' : scenario.then?.length ? 'flow' : 'run'
  const needsModel = level !== 'step' || MODEL_NODES.includes(scenario.step?.node ?? '')
  return { level, model: scenario.script ? 'script' : needsModel ? 'yours' : 'none' }
}

export const LEVEL_LABELS: Record<CheckLevel, string> = { step: 'Step', turn: 'Turn', run: 'Run', flow: 'Flow' }
export const MODEL_LABELS: Record<CheckModel, string> = { yours: 'your model', script: 'script', none: 'no model' }

export function matchesFilter(kind: CheckKind, filter: { level?: CheckLevel | undefined; model?: CheckModel | undefined }): boolean {
  return (!filter.level || kind.level === filter.level) && (!filter.model || kind.model === filter.model)
}
