import type { ModelProvider } from '../api/models'
import type { MachineRow } from './machine-rows'
import { isFree, isLocal } from './model-groups'

export type FirstModelStep = 'none' | 'connect' | 'choose'

export function firstModelStep(models: readonly ModelProvider[], defaultModelId: string | null | undefined, machines: readonly MachineRow[] = []): FirstModelStep {
  if (defaultModelId) return 'none'
  return models.length === 0 && !machines.some((row) => row.ready) ? 'connect' : 'choose'
}

const byStrength = (a: ModelProvider, b: ModelProvider) =>
  (b.intelligence ?? -1) - (a.intelligence ?? -1) || a.model.localeCompare(b.model)

export function firstModelChoices(models: readonly ModelProvider[], machines: readonly MachineRow[] = []): { yours: ModelProvider[]; machines: MachineRow[]; free: ModelProvider[]; paid: ModelProvider[] } {
  const yours = models.filter(isLocal).sort(byStrength)
  const rest = models.filter((model) => !isLocal(model))
  return {
    yours,
    machines: machines.filter((row) => row.ready).sort((a, b) => a.label.localeCompare(b.label)),
    free: rest.filter(isFree).sort(byStrength),
    paid: rest.filter((model) => !isFree(model)).sort(byStrength),
  }
}
