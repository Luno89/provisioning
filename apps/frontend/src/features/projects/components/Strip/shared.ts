import type { TreeModelRow } from '../../api/grove'
import type { Leaf } from '../../lib/leaf-types'

export const isMachineChoice = (modelId: string): boolean => modelId.startsWith('machine:')

export interface RunsOnLine {
  label: string
  picked: string[]
}

export function runsOnLine(rows: readonly TreeModelRow[], nameOf: (modelId: string) => string): RunsOnLine {
  const chosen = rows.filter((row) => row.chosen && !row.chosen.gone)
  if (chosen.length === 0) return { label: 'Each agent on its own model', picked: [] }
  const byModel = new Map<string, string[]>()
  for (const row of chosen) byModel.set(row.chosen!.modelId, [...(byModel.get(row.chosen!.modelId) ?? []), row.name])
  const picked = [...byModel.entries()].map(([modelId, names]) => `${names.join(', ')} on ${nameOf(modelId)}`)
  if (chosen.length === rows.length && byModel.size === 1) return { label: `Every agent on ${nameOf(chosen[0]!.chosen!.modelId)}`, picked }
  return { label: `${picked.join(' · ')}${chosen.length < rows.length ? ' · the rest on their own' : ''}`, picked }
}

export interface WholeTreeChange {
  agent: string
  modelId: string | null
}

export function wholeTreeChanges(rows: readonly TreeModelRow[], modelId: string | null): { changes: WholeTreeChange[]; skipped: string[] } {
  const changes: WholeTreeChange[] = []
  const skipped: string[] = []
  for (const row of rows) {
    if ('machine' in row.own) continue
    if (modelId === null) {
      if (row.chosen) changes.push({ agent: row.agent, modelId: null })
      continue
    }
    if (isMachineChoice(modelId) && row.noMachine) {
      skipped.push(row.name)
      continue
    }
    if (row.chosen?.modelId !== modelId) changes.push({ agent: row.agent, modelId })
  }
  return { changes, skipped }
}

export const workingOn = (leaves: readonly Pick<Leaf, 'title' | 'status'>[]): string[] =>
  leaves.filter((leaf) => leaf.status === 'running' || leaf.status === 'claimed').map((leaf) => leaf.title)
