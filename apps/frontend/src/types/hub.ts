/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `HubRole`, `HubAction`, `SharedProject`, `HubMember` and `HubInvite` in apps/backend/src/hub/lib/hub.ts,
 * `ProjectView` in apps/backend/src/hub/services/HubService.ts.
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
  group?: string
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
 * Authority: `SharingPreview` and `GroupCheck` in apps/backend/src/projects/services/ProjectSharingService.ts.
 */
export interface SharingPreview {
  canShare: boolean
  shared?: { hubProjectId: string; sharedAt: string }
  group?: string
  addresses: { scope: 'owner' | 'group'; example?: string }
  moves: { epics: number; features: number; stories: number; tasks: number; chats: number; repository?: string }
  stays: string[]
}

export interface GroupCheck {
  ok: boolean
  problem?: string
  suggested: string
  example?: string
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `HubStatus`, `HubRequest` and `HubRequestKind` in apps/backend/src/hub/lib/hub-board.ts,
 * `BoardView`, `ChatSummary` and `Posted` in apps/backend/src/hub/services/HubService.ts.
 */
export interface HubStatus {
  at: string
  releases: import('../api/releases').OdooRelease[]
  addresses?: { live?: string; preview?: string }
  runs: import('../components/PipelineRunRow').PipelineRun[]
  treeRuns: Record<string, import('../api/grove').TreeRunStatus>
}

export type HubRequestKind = 'approve-plan' | 'reject-plan' | 'order-stories' | 'order-features' | 'accept-task' | 'drop-task' | 'ask-koala' | 'open-chat'

export interface HubRequest {
  id: string
  kind: HubRequestKind
  input: Record<string, unknown>
  by: { personId: string; email: string; role: HubRole }
  at: string
  state: 'waiting' | 'done' | 'refused'
  why?: string
  settledAt?: string
}

export interface HubChat {
  id: string
  title: string
  kind?: 'channel' | 'item'
  leafId?: string
  branchId?: string
}

export interface HubBoardView {
  project: SharedProject
  role: HubRole
  can: HubAction[]
  online: boolean
  members: { personId: string; email: string; role: HubRole }[]
  board: {
    trees: import('../components/Projects/useProjectWork').WorkTree[]
    branches: import('./grove').Branch[]
    leaves: import('../components/leaf-types').Leaf[]
    tasks: import('../api/engine').EngineTask[]
    planProposals: import('@koala/harness-types').PlanProposal[]
    status?: HubStatus
  }
  chats: HubChat[]
  requests: HubRequest[]
}

export interface HubPosted {
  message: import('../api/chat-pack').ChatConversationMessage
  asked?: HubRequest
  notAsked?: string
}
