import { api } from './client'

export type InstallVia = 'dnf' | 'apt' | 'pip' | 'npm' | 'script' | 'base'

export type Install =
  | { via: 'dnf' | 'apt' | 'pip' | 'npm'; packages: string[] }
  | { via: 'script'; run: string }
  | { via: 'base' }

export interface ToolArgument {
  type: string
  description: string
}

export interface EngineTool {
  name: string
  ownerId?: string
  summary: string
  guidance?: string
  binding: string
  effect: 'read' | 'write' | 'propose'
  idempotent: boolean
  openWorld: boolean
  parameters: { type: 'object'; properties: Record<string, ToolArgument>; required?: string[] }
  returns: string
  failures: { when: string; says: string }[]
  command?: string
  needsBinaries?: string[]
  install?: Install
  mine: boolean
  grantedTo: string[]
}

export const engineToolKeys = {
  all: ['engine-tools'] as const,
  one: (name: string) => ['engine-tools', name] as const,
}

export async function listEngineTools(): Promise<EngineTool[]> {
  const { data } = await api.get<{ tools: EngineTool[] }>('/engine-tools')
  return data.tools
}

export interface WorkspaceBuildFailure {
  agent: string
  detail: string
}

export interface SavedTool {
  tool: EngineTool
  rebuilding: string[]
  failed: WorkspaceBuildFailure[]
}

export async function saveEngineTool(tool: EngineTool): Promise<SavedTool> {
  const { mine: _mine, grantedTo: _granted, ...body } = tool
  const { data } = await api.put<SavedTool>(
    `/engine-tools/${encodeURIComponent(tool.name)}`,
    body,
  )
  return data
}

export async function deleteEngineTool(name: string): Promise<void> {
  await api.delete(`/engine-tools/${encodeURIComponent(name)}`)
}
