import type { GrantableTool, SourcedTool } from '../api/agents'
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

export type ToolOrigin = 'built-in' | 'yours'

export interface ToolOrigins {
  of: Record<string, ToolOrigin>
  takenAway: string[]
}

export function toolOrigins(granted: readonly string[], sources: readonly SourcedTool[]): ToolOrigins {
  const shipped = sources.filter((entry) => entry.source !== 'granted').map((entry) => entry.tool)
  if (shipped.length === 0) return { of: {}, takenAway: [] }
  const builtIn = new Set(shipped)
  const held = new Set(granted)
  return {
    of: Object.fromEntries(granted.map((tool) => [tool, builtIn.has(tool) ? 'built-in' : 'yours'])),
    takenAway: shipped.filter((tool) => !held.has(tool)),
  }
}
