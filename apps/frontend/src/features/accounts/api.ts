import { api } from '../../api/client'
import type { Invite, MintedInvite, PasswordReset, PersonEntry, ProjectInviteLimits, ProjectInvitePerson, Proof, RemovalPreview, RemovalState, TwoFactorChange, TwoFactorSaved } from './types'

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

export const removeMyAccount = (confirm: string, proof: Proof): Promise<RemovalState> =>
  api.delete<{ state: RemovalState }>('/account', { data: { confirm, ...proof } }).then((r) => r.data.state)

export const listPeople = (): Promise<PersonEntry[]> =>
  api.get<{ people: PersonEntry[] }>('/admin/people').then((r) => r.data.people)

export const getPersonRemoval = (id: string): Promise<RemovalPreview> =>
  api.get<RemovalPreview>(`/admin/people/${encodeURIComponent(id)}/removal`).then((r) => r.data)

export const removePerson = (id: string, confirm: string): Promise<RemovalState> =>
  api.delete<{ state: RemovalState }>(`/admin/people/${encodeURIComponent(id)}`, { data: { confirm } }).then((r) => r.data.state)

export const endOtherSessions = (): Promise<void> =>
  api.post('/auth/sessions/end-others', {}).then(() => undefined)

export const forgotPassword = (email: string): Promise<PasswordReset> =>
  api.post<PasswordReset>('/auth/password/forgot', { email }).then((r) => r.data)

export const resendPasswordReset = (id: string): Promise<PasswordReset> =>
  api.post<PasswordReset>('/auth/password/forgot/resend', { id }).then((r) => r.data)

export const resetPassword = (body: { id: string; code: string; password: string }): Promise<{ email: string }> =>
  api.post<{ email: string }>('/auth/password/reset', body).then((r) => r.data)

export const changePassword = (body: { password: string; current?: string; code?: string }): Promise<void> =>
  api.post('/auth/password', body).then(() => undefined)

export const sendConfirmCode = (): Promise<void> =>
  api.post('/auth/confirm/code', {}).then(() => undefined)

export const saveTwoFactor = (change: TwoFactorChange, proof: Proof): Promise<TwoFactorSaved> =>
  api.post<TwoFactorSaved>('/auth/2fa/settings', { ...change, ...proof }).then((r) => r.data)
