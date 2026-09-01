export interface GroupableTool {
  name: string
  description?: string | undefined
  category: string
}

export interface ToolGroup<T extends GroupableTool> {
  key: string
  label: string
  tools: T[]
}

export type GroupState = 'all' | 'some' | 'none'

/**
 * Categories in the order they are shown. Anything a tool declares that is not listed here still
 * appears, after these — a new category should show up without an edit, just not jump the queue.
 */
export const CATEGORY_ORDER = [
  'assistant', 'web', 'planning', 'sandbox', 'git', 'http', 'linter', 'database', 'custom',
] as const

export const CATEGORY_LABELS: Record<string, string> = {
  assistant: 'Project & Infra Tools',
  web: 'Web & Search',
  sandbox: 'Sandbox (Build)',
  planning: 'Planning',
  git: 'Git',
  http: 'HTTP',
  linter: 'Lint',
  database: 'Database',
  custom: 'Custom',
}

export const categoryLabel = (key: string): string => CATEGORY_LABELS[key] ?? key

export function groupTools<T extends GroupableTool>(tools: readonly T[]): ToolGroup<T>[] {
  const byCategory = new Map<string, T[]>()
  for (const tool of tools) {
    const key = tool.category || 'custom'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key)!.push(tool)
  }

  const known = CATEGORY_ORDER.filter((key) => byCategory.has(key))
  const unknown = [...byCategory.keys()]
    .filter((key) => !(CATEGORY_ORDER as readonly string[]).includes(key))
    .sort()

  return [...known, ...unknown].map((key) => ({
    key,
    label: categoryLabel(key),
    tools: byCategory.get(key)!,
  }))
}

export function groupState(groupTools: readonly GroupableTool[], selected: readonly string[]): GroupState {
  if (groupTools.length === 0) return 'none'
  const chosen = groupTools.filter((t) => selected.includes(t.name)).length
  if (chosen === 0) return 'none'
  return chosen === groupTools.length ? 'all' : 'some'
}

/**
 * One press grants or revokes a whole group. A partly-granted group fills in rather than clearing:
 * pressing a half-checked box to get LESS access than you already had is the surprising reading.
 */
export function toggleGroup(
  selected: readonly string[],
  groupTools: readonly GroupableTool[],
): string[] {
  const names = groupTools.map((t) => t.name)
  if (groupState(groupTools, selected) === 'all') {
    return selected.filter((name) => !names.includes(name))
  }
  return [...selected, ...names.filter((name) => !selected.includes(name))]
}

export function toggleTool(selected: readonly string[], name: string): string[] {
  return selected.includes(name)
    ? selected.filter((t) => t !== name)
    : [...selected, name]
}
