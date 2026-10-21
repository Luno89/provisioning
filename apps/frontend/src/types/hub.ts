/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `HubRole`, `HubAction`, `SharedProject`, `HubMember` and `HubInvite` in apps/backend/src/lib/hub.ts,
 * `ProjectView` in apps/backend/src/services/HubService.ts.
 */
export type HubRole = 'owner' | 'collaborator' | 'client'

export const HUB_ROLES: readonly HubRole[] = ['owner', 'collaborator', 'client']

export type HubAction =
  | 'see-project' | 'see-people' | 'invite' | 'change-roles' | 'remove-people' | 'see-code' | 'approve-changes'
  | 'work-stories' | 'release' | 'see-secrets' | 'change-settings' | 'pin-and-comment' | 'ask-koala'

export interface SharedProject {
  id: string
  name: string
  createdAt: string
  createdBy: string
  origin?: { instanceId?: string; projectId: string }
}

export interface HubMember {
  personId: string
  email: string
  role: HubRole
  joinedAt: string
  invitedBy?: string
}

export interface HubInvite {
  projectId: string
  email: string
  role: HubRole
  invitedBy: string
  createdAt: string
}

export interface SharedProjectView {
  project: SharedProject
  role: HubRole
  can: HubAction[]
  members?: HubMember[]
  invites?: HubInvite[]
}

export interface Invitation {
  projectName: string
  role: HubRole
  email: string
  forYou: boolean
}

export interface InviteSent {
  email: string
  role: HubRole
  link: string
  emailed: boolean
  why?: string
}

export interface RootInvitation {
  email?: string
  project?: { name: string; role: string; join: string }
  used: boolean
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `SharingPreview` in apps/backend/src/services/ProjectSharingService.ts.
 */
export interface SharingPreview {
  shared?: { hubProjectId: string; sharedAt: string }
  moves: { epics: number; features: number; stories: number; tasks: number; chats: number; repository?: string }
  stays: string[]
}
