import type { Agent } from '../api/agents'
import type { EngineTool } from '../api/engineTools'
import type { TreeType } from '../types/grove'
import { GROUPS, groupOf, type AgentGroup } from './agent-groups'

export interface Grouped<T> {
  id: string
  title: string
  items: T[]
}

function grouped<T>(order: readonly { id: string; title: string }[], items: readonly T[], groupOfItem: (item: T) => string, key: (item: T) => string): Grouped<T>[] {
  return order
    .map((group) => ({ ...group, items: items.filter((item) => groupOfItem(item) === group.id).sort((a, b) => key(a).localeCompare(key(b))) }))
    .filter((group) => group.items.length > 0)
}

export const TOOL_GROUPS = [
  { id: 'workspace', title: 'Work in the workspace' },
  { id: 'web', title: 'Reach the web' },
  { id: 'look', title: 'Look things up' },
  { id: 'propose', title: 'Propose and ask you' },
  { id: 'change', title: 'Change things on the platform' },
  { id: 'other', title: 'Other' },
] as const

export function toolGroupOf(tool: Pick<EngineTool, 'binding' | 'effect'>): string {
  if (tool.binding === 'environment') return 'workspace'
  if (tool.binding === 'network') return 'web'
  if (tool.binding !== 'platform') return 'other'
  return tool.effect === 'read' ? 'look' : tool.effect === 'propose' ? 'propose' : 'change'
}

export function groupTools<T extends Pick<EngineTool, 'name' | 'binding' | 'effect'>>(tools: readonly T[]): Grouped<T>[] {
  return grouped(TOOL_GROUPS, tools, toolGroupOf, (tool) => tool.name)
}

export const PROCEDURE_GROUPS = [
  { id: 'chat', title: 'Run by agents you talk to' },
  { id: 'platform', title: 'Run by the platform\u2019s agents' },
  { id: 'tree-type', title: 'Grow trees' },
  { id: 'procedure', title: 'Run by agents inside other procedures' },
  { id: 'hand-off', title: 'Run by agents handed work' },
  { id: 'idle', title: 'Run only by agents nothing uses' },
  { id: 'unused', title: 'Not run by any agent' },
] as const

export type ProcedureGroup = typeof PROCEDURE_GROUPS[number]['id']

export const runnersOf = (procedureId: string, agents: readonly Pick<Agent, 'slug' | 'procedure'>[]): string[] =>
  agents.filter((agent) => agent.procedure === procedureId).map((agent) => agent.slug).sort()

export function procedureGroupOf(procedureId: string, agents: readonly Pick<Agent, 'slug' | 'procedure' | 'usedBy'>[]): ProcedureGroup {
  const runners = agents.filter((agent) => agent.procedure === procedureId)
  if (runners.length === 0) return 'unused'
  const theirs = new Set<AgentGroup>(runners.map(groupOf))
  return GROUPS.find((group) => group.id !== 'unused' && theirs.has(group.id))?.id as ProcedureGroup | undefined ?? 'idle'
}

export function groupProcedures<T extends { id: string }>(procedures: readonly T[], agents: readonly Pick<Agent, 'slug' | 'procedure' | 'usedBy'>[]): Grouped<T>[] {
  return grouped(PROCEDURE_GROUPS, procedures, (procedure) => procedureGroupOf(procedure.id, agents), (procedure) => procedure.id)
}

export const TREE_TYPE_GROUPS = [
  { id: 'service', title: 'Build something that runs' },
  { id: 'artefact', title: 'Produce a document or artefact' },
] as const

export function groupTreeTypes<T extends Pick<TreeType, 'label' | 'produces'>>(types: readonly T[]): Grouped<T>[] {
  return grouped(TREE_TYPE_GROUPS, types, (type) => type.produces, (type) => type.label)
}
