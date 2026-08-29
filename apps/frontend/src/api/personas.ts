import { api } from './client'
import type { Persona } from '../components/PersonaEditor'

export interface PersonaOptions {
  languages: { id: string; image: string; summary: string; available: string[]; absent: string[] }[];
  tools: { name: string; description?: string }[];
  mcpServers?: { name: string; tools: number; unreachable?: string }[];
  defaults: { cpu: string; memory: string; maxSteps: number };
}

export const personaKeys = {
  list: () => ['personas'] as const,
  options: () => ['persona-options'] as const,
}

export const listPersonas = (): Promise<Persona[]> =>
  api.get<Persona[]>('/personas').then((r) => r.data)

export const createPersona = (body: unknown) => api.post('/personas', body).then((r) => r.data)

export const updatePersona = (id: string, body: unknown) =>
  api.put(`/personas/${id}`, body).then((r) => r.data)

export const deletePersona = (id: string) => api.delete(`/personas/${id}`).then((r) => r.data)

export const getPersonaOptions = (): Promise<PersonaOptions> =>
  api.get<PersonaOptions>('/persona-options').then((r) => r.data)
