import type { McpServer, McpServerRuns, McpToolKind } from '../../api/mcp'

export type ServerPlace = 'workspace' | 'url' | 'deployment'

export const placeOf = (runs: McpServerRuns): ServerPlace =>
  runs.where === 'workspace' ? 'workspace' : 'deploymentId' in runs ? 'deployment' : 'url'

export const PLACE_TITLES: Record<ServerPlace, string> = {
  workspace: 'Run in the workspace',
  url: 'Hosted at an address',
  deployment: 'Your deployments',
}

export function statusText(server: Pick<McpServer, 'status'>): string {
  const status = server.status
  if (status.state === 'capturing') return 'being captured…'
  if (status.state === 'captured') return `${status.tools} tool${status.tools === 1 ? '' : 's'}`
  if (status.state === 'failed') return 'capture failed'
  if (status.state === 'stale') return 'changed since captured'
  return 'not captured yet'
}

export const serverLine = (server: Pick<McpServer, 'runs' | 'status'>): string =>
  `${placeOf(server.runs) === 'workspace' ? 'in the workspace' : 'hosted'} · ${statusText(server)}`

export function groupServers<T extends Pick<McpServer, 'runs' | 'name'>>(servers: readonly T[]): { place: ServerPlace; title: string; servers: T[] }[] {
  return (['workspace', 'url', 'deployment'] as const)
    .map((place) => ({ place, title: PLACE_TITLES[place], servers: servers.filter((server) => placeOf(server.runs) === place).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((group) => group.servers.length > 0)
}

export interface WorkspaceForm {
  languages: string[]
  needs: string[]
  start: string
  port: string
  path: string
}

export function formOf(runs: Extract<McpServerRuns, { where: 'workspace' }>): WorkspaceForm {
  return {
    languages: [...(runs.languages ?? [])],
    needs: [...runs.needs],
    start: runs.start,
    port: String(runs.port),
    path: runs.path ?? '',
  }
}

export function runsOf(form: WorkspaceForm): Extract<McpServerRuns, { where: 'workspace' }> {
  return {
    where: 'workspace',
    ...(form.languages.length > 0 ? { languages: [...form.languages] } : {}),
    needs: [...form.needs],
    start: form.start.trim(),
    port: Number(form.port.replace(/[^0-9]/g, '')),
    ...(form.path.trim() ? { path: form.path.trim() } : {}),
  }
}

export const isOffered = (server: Pick<McpServer, 'offer' | 'omit'>, tool: string): boolean =>
  (server.offer === undefined || server.offer.includes(tool)) && !(server.omit ?? []).includes(tool)

export function withOffered(server: Pick<McpServer, 'offer' | 'omit'>, tool: string, offered: boolean): { offer: string[] | null; omit: string[] | null } {
  if (server.offer !== undefined) {
    const offer = offered ? [...new Set([...server.offer, tool])] : server.offer.filter((name) => name !== tool)
    return { offer, omit: null }
  }
  const omit = offered ? (server.omit ?? []).filter((name) => name !== tool) : [...new Set([...(server.omit ?? []), tool])]
  return { offer: null, omit: omit.length > 0 ? omit : null }
}

export function withToolSaid(server: Pick<McpServer, 'tools'>, tool: string, said: { note?: string; kind?: McpToolKind | '' }): NonNullable<McpServer['tools']> {
  const current = server.tools?.[tool] ?? {}
  const next = { ...current }
  if (said.note !== undefined) {
    if (said.note.trim()) next.note = said.note
    else delete next.note
  }
  if (said.kind !== undefined) {
    if (said.kind) next.kind = said.kind
    else delete next.kind
  }
  const tools = { ...(server.tools ?? {}) }
  if (Object.keys(next).length > 0) tools[tool] = next
  else delete tools[tool]
  return tools
}

export function declaredKind(annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined): McpToolKind {
  if (annotations?.readOnlyHint === true) return 'read-only'
  return annotations?.destructiveHint === false ? 'safe-write' : 'destructive'
}
