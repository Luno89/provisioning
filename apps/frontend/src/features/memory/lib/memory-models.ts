export const ANY_MODEL = 'any'
export const EVERY_MODEL = 'every'

export function modelChoices(
  memories: readonly { model?: string | undefined }[],
  providers: readonly { id: string; source: string; model: string }[],
  defaultModelId?: string | null,
): string[] {
  const inUse = providers.filter((provider) => provider.source === 'deployment' || provider.id === defaultModelId)
  const names = [...memories.map((memory) => memory.model), ...inUse.map((provider) => provider.model)]
  return [...new Set(names.filter((name): name is string => Boolean(name)))].sort((a, b) => a.localeCompare(b))
}

export function matchesModel(memory: { model?: string | undefined }, filter: string): boolean {
  if (filter === ANY_MODEL) return true
  if (filter === EVERY_MODEL) return !memory.model
  return !memory.model || memory.model === filter
}

export const modelLine = (model: string | undefined): string => (model ? `only for ${model}` : 'every model')
