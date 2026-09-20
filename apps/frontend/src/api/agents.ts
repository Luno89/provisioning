import { api } from './client'

export interface AgentImage {
  state: 'ready' | 'building' | 'failed' | 'unbuilt'
  reference: string
  detail?: string
}

export interface AgentEnvironment {
  terminal?: boolean
  filesystem?: boolean
  egress?: boolean
  git?: boolean
  languages?: string[]
  workspace?: boolean
}

export interface Agent {
  slug: string
  ownerId?: string
  name: string
  description: string
  version: string
  prompt: string
  guidance: string
  returns: string
  failures: { when: string; says: string }[]
  procedure: string
  tools: string[]
  agents?: string[]
  environment: AgentEnvironment
  model?: { endpointId?: string | null; reasoningEffort?: string; replyCeiling?: number }
  interface?: { inputs?: unknown; outputs?: string[] }
  mine: boolean
  image?: AgentImage
}

export interface GrantableTool {
  name: string
  summary: string
  binding: string
  needs: string[]
}

export const agentKeys = {
  all: ['agents'] as const,
  one: (slug: string) => ['agents', slug] as const,
  tools: ['agents', 'tools'] as const,
}

export interface Grantable {
  tools: GrantableTool[]
  languages: string[]
}

export async function listGrantableTools(): Promise<Grantable> {
  const { data } = await api.get<Grantable>('/agents/tools')
  return data
}

export async function listAgents(): Promise<Agent[]> {
  const { data } = await api.get<{ agents: Agent[] }>('/agents')
  return data.agents
}

export async function getAgent(slug: string): Promise<Agent> {
  const { data } = await api.get<{ agent: Agent }>(`/agents/${encodeURIComponent(slug)}`)
  return data.agent
}

export async function saveAgent(agent: Agent): Promise<Agent> {
  const { mine: _mine, image: _image, ...body } = agent
  const { data } = await api.put<{ agent: Agent }>(`/agents/${encodeURIComponent(agent.slug)}`, body)
  return data.agent
}

export async function deleteAgent(slug: string): Promise<void> {
  await api.delete(`/agents/${encodeURIComponent(slug)}`)
}
