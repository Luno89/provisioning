import type { GrantableTool } from '../api/agents'
import { groupTools, type Grouped } from './studio-groups'

export interface ToolChoices {
  granted: Grouped<GrantableTool>[]
  available: Grouped<GrantableTool>[]
  unknown: string[]
}

export function toolChoices(granted: readonly string[], grantable: readonly GrantableTool[], search = ''): ToolChoices {
  const held = new Set(granted)
  const wanted = search.trim().toLowerCase()
  const matches = (tool: GrantableTool) => !wanted || tool.name.toLowerCase().includes(wanted) || tool.summary.toLowerCase().includes(wanted)
  return {
    granted: groupTools(grantable.filter((tool) => held.has(tool.name))),
    available: groupTools(grantable.filter((tool) => !held.has(tool.name) && matches(tool))),
    unknown: granted.filter((name) => !grantable.some((tool) => tool.name === name)).sort(),
  }
}
