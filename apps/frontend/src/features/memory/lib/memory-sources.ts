export const ANY_SOURCE = 'any'
export const OUTSIDE_SOURCE = 'outside'
export const HOST_PREFIX = 'host:'

/**
 * ── DUPLICATED, KNOWINGLY ── `MemorySources` in apps/backend/src/memory/lib/memory-store.ts and `OUTSIDE_CLASSES` in
 * apps/backend/src/engine/lib/poisoning.ts are the authority.
 */
export interface MemorySources {
  classes: string[]
  hosts: string[]
  runs: string[]
}

const OUTSIDE_CLASSES = ['web', 'mcp', 'agent', 'logs', 'file']

const CLASS_WORDS: Readonly<Record<string, string>> = {
  web: 'the web',
  logs: 'app logs',
  cluster: 'cluster state',
  file: 'stored files',
  repo: 'the repository',
  mcp: 'an MCP server',
  agent: 'another agent',
  private: 'the person\'s own records',
}

type WithSources = { provenance?: { sources?: MemorySources | undefined } | undefined }

const sourcesOf = (memory: WithSources): MemorySources | undefined => memory.provenance?.sources

export const fromOutside = (memory: WithSources): boolean => (sourcesOf(memory)?.classes ?? []).some((one) => OUTSIDE_CLASSES.includes(one))

export function sourceChoices(memories: readonly WithSources[]): Array<{ value: string; label: string }> {
  const classes = [...new Set(memories.flatMap((memory) => sourcesOf(memory)?.classes ?? []))].sort()
  const hosts = [...new Set(memories.flatMap((memory) => sourcesOf(memory)?.hosts ?? []))].sort()
  if (!classes.length && !hosts.length) return []
  return [
    { value: OUTSIDE_SOURCE, label: 'Learned from outside text' },
    ...classes.map((one) => ({ value: one, label: `Learned from ${CLASS_WORDS[one] ?? one}` })),
    ...hosts.map((host) => ({ value: `${HOST_PREFIX}${host}`, label: `Learned from ${host}` })),
  ]
}

export function matchesSource(memory: WithSources, filter: string): boolean {
  if (filter === ANY_SOURCE) return true
  const sources = sourcesOf(memory)
  if (filter === OUTSIDE_SOURCE) return fromOutside(memory)
  if (filter.startsWith(HOST_PREFIX)) return (sources?.hosts ?? []).includes(filter.slice(HOST_PREFIX.length))
  return (sources?.classes ?? []).includes(filter)
}

export function sourcesLine(memory: WithSources): string | undefined {
  const sources = sourcesOf(memory)
  if (!sources || (!sources.classes.length && !sources.hosts.length)) return undefined
  const read = sources.classes.map((one) => CLASS_WORDS[one] ?? one)
  return `learned while reading ${read.length ? read.join(', ') : 'nothing outside'}${sources.hosts.length ? ` (${sources.hosts.join(', ')})` : ''}`
}
