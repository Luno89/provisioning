import type { McpRequest } from '@koala/harness-types'
import { api } from './client'

export type McpToolKind = 'read-only' | 'safe-write' | 'destructive'

export interface McpToolSummary {
  name: string
  description?: string
  readOnly: boolean
  kind: McpToolKind
  declared: McpToolKind
}

export interface McpServerSummary {
  name: string
  tools: McpToolSummary[]
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `ServerRuns`, `McpServerRecord`, `McpServerTemplate` and `ServerState` in apps/backend/src/lib/mcp-servers.ts,
 * and `McpServerView` / `McpCatalogue` in apps/backend/src/services/McpServerService.ts.
 */
export type McpServerRuns =
  | { where: 'hosted'; url: string }
  | { where: 'hosted'; deploymentId: string }
  | { where: 'workspace'; languages?: string[]; needs: string[]; start: string; port: number; path?: string }

export interface McpCapturedTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}

export type McpServerState =
  | { state: 'capturing'; runId: string }
  | { state: 'captured'; tools: number }
  | { state: 'failed'; why: string }
  | { state: 'stale' }
  | { state: 'new' }

export interface McpServer {
  id: string
  name: string
  summary?: string
  runs: McpServerRuns
  offer?: string[]
  omit?: string[]
  notes?: string
  dependsOn?: string
  tools?: Record<string, { note?: string; kind?: McpToolKind }>
  captured?: { instructions?: string; serverInfo?: { name?: string; version?: string }; tools: McpCapturedTool[]; at: string }
  failed?: { at: string; why: string }
  capturing?: { runId: string; at: string }
  from?: { template: string } | { projectId: string }
  status: McpServerState
  createdAt: string
  updatedAt: string
}

export interface McpServerTemplate {
  id: string
  name: string
  summary: string
  runs: McpServerRuns
  added: boolean
}

export interface McpCatalogue {
  servers: McpServer[]
  templates: McpServerTemplate[]
}

export interface McpServerChange {
  name?: string
  summary?: string
  runs?: McpServerRuns
  tools?: McpServer['tools']
  offer?: string[] | null
  omit?: string[] | null
  notes?: string | null
  dependsOn?: string | null
}

export const mcpKeys = {
  all: ['mcp'] as const,
  servers: () => ['mcp', 'servers'] as const,
  catalogue: () => ['mcp', 'catalogue'] as const,
  requests: (conversationId: string) => ['mcp', 'requests', conversationId] as const,
}

export const listMcpServers = (): Promise<McpServerSummary[]> =>
  api.get<McpServerSummary[]>('/mcp/servers').then((r) => r.data)

export const getMcpCatalogue = (): Promise<McpCatalogue> =>
  api.get<McpCatalogue>('/mcp/catalogue').then((r) => r.data)

export const addMcpServer = (server: { template: string } | { name: string; runs: McpServerRuns; summary?: string }): Promise<McpServer> =>
  api.post<McpServer>('/mcp/catalogue', server).then((r) => r.data)

export const saveMcpServer = (id: string, change: McpServerChange): Promise<McpServer> =>
  api.put<McpServer>(`/mcp/catalogue/${encodeURIComponent(id)}`, change).then((r) => r.data)

export const captureMcpServer = (id: string): Promise<McpServer> =>
  api.post<McpServer>(`/mcp/catalogue/${encodeURIComponent(id)}/capture`).then((r) => r.data)

export const removeMcpServer = (id: string): Promise<{ removed: true }> =>
  api.delete<{ removed: true }>(`/mcp/catalogue/${encodeURIComponent(id)}`).then((r) => r.data)

export const listMcpRequests = (conversationId: string): Promise<McpRequest[]> =>
  api.get<McpRequest[]>('/mcp/requests', { params: { conversationId } }).then((r) => r.data)

export const enableMcpRequest = (id: string): Promise<{ request: McpRequest }> =>
  api.post<{ request: McpRequest }>(`/mcp/requests/${id}/enable`).then((r) => r.data)

export const dismissMcpRequest = (id: string): Promise<{ request: McpRequest }> =>
  api.post<{ request: McpRequest }>(`/mcp/requests/${id}/dismiss`).then((r) => r.data)

export const setConversationServers = (conversationId: string, servers: string[]): Promise<unknown> =>
  api.put(`/mcp/conversations/${conversationId}/servers`, { servers }).then((r) => r.data)
