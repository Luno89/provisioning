import { api } from './client'

export type { ToolEffect } from '@koala/harness-types'

/**
 * The backend's shape, imported rather than restated.
 *
 * This file declared its own copy, and it drifted: it still listed `toolset` and `permitted` long
 * after those were deleted, then kept `overrides` after that went too. Nothing caught it — the
 * compiler had no second shape to compare, backend tests test the backend, and the frontend's own
 * tests mock these modules. Only Playwright crosses the wire, and it needs Docker to run.
 */
export type { PersonaPack } from '@koala/harness-types'

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
