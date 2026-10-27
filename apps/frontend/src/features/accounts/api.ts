import { api } from '../../api/client'
import type { Invite, MintedInvite, PersonEntry, ProjectInviteLimits, ProjectInvitePerson, RemovalPreview, RemovalState } from './types'

export const accountKeys = {
  removal: () => ['account', 'removal'] as const,
  people: () => ['admin', 'people'] as const,
  personRemoval: (id: string) => ['admin', 'people', id, 'removal'] as const,
  invites: () => ['admin', 'invites'] as const,
  projectInvites: () => ['admin', 'project-invites'] as const,
}

export const getProjectInviteLimits = (): Promise<ProjectInviteLimits> =>
  api.get<ProjectInviteLimits>('/admin/project-invites').then((r) => r.data)

export const setProjectInviteLimits = (limits: { accounts?: number; perHour?: number }): Promise<{ accounts: number; perHour: number }> =>
  api.put<{ accounts: number; perHour: number }>('/admin/project-invites', limits).then((r) => r.data)

export const setOwnInviteAccounts = (id: string, accounts: number | null): Promise<ProjectInvitePerson> =>
  api.put<ProjectInvitePerson>(`/admin/people/${encodeURIComponent(id)}/project-invites`, { accounts }).then((r) => r.data)

export const listInvites = (): Promise<Invite[]> =>
  api.get<Invite[]>('/admin/invites').then((r) => r.data)

export const mintInvite = (): Promise<MintedInvite> =>
  api.post<MintedInvite>('/admin/invites', {}).then((r) => r.data)

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

export const endOtherSessions = (): Promise<void> =>
  api.post('/auth/sessions/end-others', {}).then(() => undefined)
