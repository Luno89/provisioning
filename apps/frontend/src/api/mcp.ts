import type { McpRequest } from '@koala/harness-types'
import { api } from './client'

export type McpToolKind = 'read-only' | 'safe-write' | 'destructive'
export type McpHintChoice = 'server' | McpToolKind

export interface McpToolSummary {
  name: string
  description?: string
  readOnly: boolean
  kind: McpToolKind
  declared: McpToolKind
  choice: McpHintChoice
}

export interface McpServerSummary {
  name: string
  tools: McpToolSummary[]
  unreachable?: string
}

export const mcpKeys = {
  all: ['mcp'] as const,
  servers: () => ['mcp', 'servers'] as const,
  requests: (conversationId: string) => ['mcp', 'requests', conversationId] as const,
}

export const listMcpServers = (): Promise<McpServerSummary[]> =>
  api.get<McpServerSummary[]>('/mcp/servers').then((r) => r.data)

export const setMcpToolHint = (server: string, tool: string, choice: McpHintChoice): Promise<McpServerSummary[]> =>
  api.put<McpServerSummary[]>(`/mcp/servers/${encodeURIComponent(server)}/tools/${encodeURIComponent(tool)}/hint`, { choice }).then((r) => r.data)

export const listMcpRequests = (conversationId: string): Promise<McpRequest[]> =>
  api.get<McpRequest[]>('/mcp/requests', { params: { conversationId } }).then((r) => r.data)

export const enableMcpRequest = (id: string): Promise<{ request: McpRequest }> =>
  api.post<{ request: McpRequest }>(`/mcp/requests/${id}/enable`).then((r) => r.data)

export const dismissMcpRequest = (id: string): Promise<{ request: McpRequest }> =>
  api.post<{ request: McpRequest }>(`/mcp/requests/${id}/dismiss`).then((r) => r.data)

export const setConversationServers = (conversationId: string, servers: string[]): Promise<unknown> =>
  api.put(`/mcp/conversations/${conversationId}/servers`, { servers }).then((r) => r.data)
