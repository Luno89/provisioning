import { api } from './client'
// ── DUPLICATED, KNOWINGLY ── `Persona` is declared in `components/PersonaEditor.tsx`, which is
// where the editing UI defines it; the backend authority is `apps/backend/src/lib/types.ts`.
// Imported rather than re-declared so there is still exactly one frontend answer.
import type { Persona } from '../components/PersonaEditor'

/**
 * What a persona may legally be set to.
 *
 * Promoted from `PersonaEditor.tsx`, which held the real shape. The first draft here invented a
 * loose `{ models?, roles? }` and the compiler refused to reconcile it with the editor's use —
 * correctly, since neither field exists.
 *
 * Every list in here is DATA the editor renders itself from: which languages a workspace can run,
 * which tools exist, which MCP servers are actually deployed. Hardcoding any of it would put the
 * validation rules in two places, and the copy in the UI is the one that silently stops matching.
 */
export interface PersonaOptions {
  languages: { id: string; image: string; summary: string; available: string[]; absent: string[] }[];
  tools: { name: string; description?: string }[];
  /** What is actually deployed, so a grant is a click rather than a remembered name. */
  mcpServers?: { name: string; tools: number; unreachable?: string }[];
  defaults: { cpu: string; memory: string; maxSteps: number };
}

/**
 * Personas, and the options a persona may be set to.
 *
 * ── WHY `persona-options` IS A FETCH AND NOT A CONSTANT ──
 * Which models a persona may use, and which roles exist, are database records the user edits. The
 * editor renders itself from this response, so adding a role is a data change with no matching UI
 * edit — and, more to the point, so that nothing in this codebase encodes what a persona IS.
 * Hardcoding the list here would put the validation rules in two places, and the one in the UI
 * would be the one that silently stopped matching.
 */

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

/** What a persona may legally be set to — models, roles, and the scope rules over them. */
export const getPersonaOptions = (): Promise<PersonaOptions> =>
  api.get<PersonaOptions>('/persona-options').then((r) => r.data)
