import { api } from './client'
import type { PersonEntry, RemovalPreview, RemovalState } from '../types/account'

export const accountKeys = {
  removal: () => ['account', 'removal'] as const,
  people: () => ['admin', 'people'] as const,
  personRemoval: (id: string) => ['admin', 'people', id, 'removal'] as const,
}

export const getRemovalPreview = (): Promise<RemovalPreview> =>
  api.get<RemovalPreview>('/account/removal').then((r) => r.data)

export const removeMyAccount = (confirm: string): Promise<RemovalState> =>
  api.delete<{ state: RemovalState }>('/account', { data: { confirm } }).then((r) => r.data.state)

export const listPeople = (): Promise<PersonEntry[]> =>
  api.get<{ people: PersonEntry[] }>('/admin/people').then((r) => r.data.people)

export const getPersonRemoval = (id: string): Promise<RemovalPreview> =>
  api.get<RemovalPreview>(`/admin/people/${encodeURIComponent(id)}/removal`).then((r) => r.data)

export const removePerson = (id: string, confirm: string): Promise<RemovalState> =>
  api.delete<{ state: RemovalState }>(`/admin/people/${encodeURIComponent(id)}`, { data: { confirm } }).then((r) => r.data.state)
