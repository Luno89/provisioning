import { api } from './client'
// ── DUPLICATED, KNOWINGLY ── `Persona` is declared in `components/PersonaEditor.tsx`, which is
// where the editing UI defines it; the backend authority is `apps/backend/src/lib/types.ts`.
// Imported rather than re-declared so there is still exactly one frontend answer.
import type { Persona } from '../components/PersonaEditor'

/**
 * What a persona may legally be set to.
 *
 * Deliberately loose: the response is a set of option lists the editor renders itself from, and
 * naming each one here would be a second place that has to learn about a new kind of option.
 */
export interface PersonaOptions {
  models?: string[]
  roles?: string[]
  [key: string]: unknown
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
