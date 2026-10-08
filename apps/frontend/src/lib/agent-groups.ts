import type { Agent, AgentUsage } from '../api/agents'

export type AgentGroup = AgentUsage['kind'] | 'unused'

export const GROUPS: readonly { id: AgentGroup; title: string }[] = [
  { id: 'chat', title: 'You talk to' },
  { id: 'platform', title: 'Run by the platform' },
  { id: 'tree-type', title: 'Grow trees' },
  { id: 'procedure', title: 'Run inside procedures' },
  { id: 'hand-off', title: 'Handed work by other agents' },
  { id: 'unused', title: 'Not used yet' },
]

export function groupOf(agent: Pick<Agent, 'usedBy'>): AgentGroup {
  const kinds = new Set((agent.usedBy ?? []).map((usage) => usage.kind))
  return GROUPS.find((group) => group.id !== 'unused' && kinds.has(group.id as AgentUsage['kind']))?.id ?? 'unused'
}

export function groupAgents<T extends Pick<Agent, 'slug' | 'name' | 'usedBy'>>(agents: readonly T[], filter = ''): { id: AgentGroup; title: string; agents: T[] }[] {
  const wanted = filter.trim().toLowerCase()
  const shown = agents.filter((agent) => !wanted || agent.slug.includes(wanted) || agent.name.toLowerCase().includes(wanted))
  return GROUPS
    .map((group) => ({ ...group, agents: shown.filter((agent) => groupOf(agent) === group.id).sort((a, b) => a.slug.localeCompare(b.slug)) }))
    .filter((group) => group.agents.length > 0)
}

const KIND_SAYS: Record<AgentUsage['kind'], (by: string) => string> = {
  chat: (by) => `talked to in ${by}`,
  platform: (by) => `run by the platform: ${by}`,
  'tree-type': (by) => `grows ${by} trees`,
  procedure: (by) => `run by the ${by} procedure`,
  'hand-off': (by) => `handed work by ${by}`,
}

export function describeUsage(usage: AgentUsage): string {
  return KIND_SAYS[usage.kind](usage.by)
}
