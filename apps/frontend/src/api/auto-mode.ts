import { api } from './client'

export const autoModeKeys = {
  agents: () => ['auto-mode', 'agents'] as const,
}

export const listAutoModeAgents = (): Promise<string[]> =>
  api.get<{ agents: string[] }>('/auto-mode').then((r) => r.data.agents)

export const setAgentAutoMode = (slug: string, on: boolean): Promise<string[]> =>
  api.put<{ agents: string[] }>(`/auto-mode/agents/${encodeURIComponent(slug)}`, { on }).then((r) => r.data.agents)

export const setTreeAutoMode = (treeId: string, on: boolean): Promise<boolean> =>
  api.put<{ autoMode: boolean }>(`/auto-mode/trees/${encodeURIComponent(treeId)}`, { on }).then((r) => r.data.autoMode)
