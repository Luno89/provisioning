import { api } from './client'

/**
 * Packs: how a persona is being run, as records the server owns.
 *
 * ── WHY THIS IS FETCHED AND NOT A CONSTANT ──
 * `ChatSurface` held the pack list as a literal array of three, while the server's registry held
 * two — and the extra one, `researcher`, existed in neither place. Selecting it posted to a pack id
 * the server had never heard of and produced a 500 that named neither list.
 *
 * Two lists describing one thing is the failure this codebase has already had with leaf columns,
 * cluster providers and tree types, and a served catalogue is how each of those was fixed. So the
 * picker renders from this, and adding a pack is a database row with no matching UI edit.
 */

/** What a tool call does, for the action gate. Authority: `apps/backend/src/lib/action-gate.ts`. */
export type ToolEffect = 'read' | 'write' | 'propose'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * The authority is `PersonaPack` in `packages/harness-types/src/index.ts`, which the backend
 * imports directly. Restated here without the server-only fields so the chat surface has a shape
 * to render, in the same way `PersonaOptions` restates what the editor needs.
 */
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
