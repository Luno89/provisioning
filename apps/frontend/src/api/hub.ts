import { api } from './client'
import type { HubRole, Invitation, InviteSent, RootInvitation, SharedProject, SharedProjectView, SharingPreview } from '../types/hub'

export const hubKeys = {
  all: ['hub'] as const,
  mine: ['hub', 'mine'] as const,
  project: (id: string) => ['hub', 'project', id] as const,
  invitation: (token: string) => ['hub', 'invitation', token] as const,
  rootInvitation: (code: string) => ['hub', 'root-invitation', code] as const,
}

const project = (id: string) => `/hub/projects/${encodeURIComponent(id)}`

export const listSharedProjects = (): Promise<{ project: SharedProject; role: HubRole }[]> =>
  api.get<{ project: SharedProject; role: HubRole }[]>('/hub/projects').then((r) => r.data)

export const getSharedProject = (id: string): Promise<SharedProjectView> =>
  api.get<SharedProjectView>(project(id)).then((r) => r.data)

export const deleteSharedProject = (id: string, name: string): Promise<{ deleted: string }> =>
  api.delete<{ deleted: string }>(project(id), { data: { name } }).then((r) => r.data)

export const inviteToProject = (id: string, body: { email: string; role: HubRole }): Promise<InviteSent> =>
  api.post<InviteSent>(`${project(id)}/invites`, body).then((r) => r.data)

export const takeInviteBack = (id: string, email: string): Promise<{ email: string }> =>
  api.delete<{ email: string }>(`${project(id)}/invites`, { params: { email } }).then((r) => r.data)

export const changeMemberRole = (id: string, personId: string, role: HubRole): Promise<SharedProjectView> =>
  api.put<SharedProjectView>(`${project(id)}/members/${encodeURIComponent(personId)}`, { role }).then((r) => r.data)

export const removeMember = (id: string, personId: string): Promise<{ removed: string }> =>
  api.delete<{ removed: string }>(`${project(id)}/members/${encodeURIComponent(personId)}`).then((r) => r.data)

export const getInvitation = (token: string): Promise<Invitation> =>
  api.get<Invitation>(`/hub/invitations/${encodeURIComponent(token)}`).then((r) => r.data)

export const acceptInvitation = (token: string): Promise<SharedProjectView> =>
  api.post<SharedProjectView>(`/hub/invitations/${encodeURIComponent(token)}/accept`).then((r) => r.data)

export const getRootInvitation = (code: string): Promise<RootInvitation> =>
  api.get<RootInvitation>('/hub-link/invitation', { params: { code } }).then((r) => r.data)

export const HUB_GO_URL = (next: string): string => `/api/identity/go?to=hub&next=${encodeURIComponent(next)}`

export const hubElsewhere = (): Promise<string | null> =>
  api.get<{ hub?: string | null }>('/auth/sign-in').then((r) => r.data.hub ?? null).catch(() => null)

export const sharingKeys = { of: (projectId: string) => ['project-sharing', projectId] as const }

export const getSharing = (projectId: string): Promise<SharingPreview> =>
  api.get<SharingPreview>(`/project-sharing/${encodeURIComponent(projectId)}`).then((r) => r.data)

export const shareProject = (projectId: string): Promise<SharingPreview> =>
  api.post<SharingPreview>(`/project-sharing/${encodeURIComponent(projectId)}`).then((r) => r.data)

export const takeProjectBack = (projectId: string, confirm: string): Promise<SharingPreview> =>
  api.delete<SharingPreview>(`/project-sharing/${encodeURIComponent(projectId)}`, { data: { confirm } }).then((r) => r.data)
