import { api } from './client'

export type ToolEffect = 'read' | 'write' | 'propose'

export interface PersonaPack {
  id: string
  slug: string
  name: string
  description?: string
  personaId: string
  toolset: 'assistant' | 'workbench' | 'none'
  tools: string[]
  permitted: ToolEffect[]
  overrides: Record<string, unknown>
  builtIn?: boolean
}

export const packKeys = {
  list: () => ['packs'] as const,
  detail: (id: string) => ['pack', id] as const,
}

export const listPacks = (): Promise<PersonaPack[]> =>
  api.get<PersonaPack[]>('/packs').then((r) => r.data)

export const getPack = (id: string): Promise<PersonaPack> =>
  api.get<PersonaPack>(`/packs/${id}`).then((r) => r.data)

export const createPack = (body: Partial<PersonaPack>): Promise<PersonaPack> =>
  api.post<PersonaPack>('/packs', body).then((r) => r.data)

export const updatePack = (id: string, body: Partial<PersonaPack>): Promise<PersonaPack> =>
  api.put<PersonaPack>(`/packs/${id}`, body).then((r) => r.data)

export const deletePack = (id: string): Promise<void> =>
  api.delete(`/packs/${id}`).then(() => undefined)
