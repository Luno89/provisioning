/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `RemovalWorkflowState`, `PersonEntry` and `PersonInstance` in apps/backend/src/accounts/services/AccountRemovalService.ts,
 * `InviteMetadata` in apps/backend/src/platform/lib/types.ts,
 * `RemovalStep` in apps/backend/src/accounts/lib/account-removal.ts.
 */
export type RemovalStep = 'workflows' | 'apps' | 'workspaces' | 'secrets' | 'mesh' | 'repositories' | 'records' | 'instance'

export type RemovalState =
  | { state: 'running'; done: RemovalStep[] }
  | { state: 'failed'; reason: string }
  | { state: 'finished' }
  | { state: 'none' }

export interface PersonInstance {
  name?: string
  where: 'pool' | 'own'
  status: 'waiting' | 'joined' | 'installing' | 'ready' | 'failed' | 'paused'
  detail?: string
  url: string
  trialEndsAt?: string
  version?: string
  autoUpdates?: boolean
}

export interface PersonEntry {
  id: string
  email: string
  isAdmin: boolean
  createdAt: string
  instance?: PersonInstance
  removal?: { startedAt: string; requestedBy: string; state: RemovalState; steps?: RemovalStep[] }
}

export interface Invite {
  id: string
  createdBy: string
  createdAt: string
  expiresAt?: string
  expired: boolean
  usedBy?: string
  usedAt?: string
}

export interface ProjectInvitePerson {
  id: string
  email: string
  made: number
  own?: number
}

export interface ProjectInviteLimits {
  accounts: number
  perHour: number
  people: ProjectInvitePerson[]
}

export interface MintedInvite extends Invite {
  code: string
}

export interface RemovalPreview {
  email: string
  blockers: string[]
  instance?: PersonInstance
}

export interface RemovalRefusal {
  error: string
  blockers?: string[]
}
