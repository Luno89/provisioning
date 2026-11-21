/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `RemovalWorkflowState`, `PersonEntry` and `PersonInstance` in apps/backend/src/accounts/services/AccountRemovalService.ts,
 * `InviteMetadata` in apps/backend/src/platform/lib/types.ts,
 * `RemovalStep` in apps/backend/src/accounts/lib/account-removal.ts.
 */
import type { DeletionProgress } from '../projects'

export type RemovalStep = 'workflows' | 'projects' | 'apps' | 'workspaces' | 'secrets' | 'mesh' | 'repositories' | 'records' | 'instance' | 'koala' | 'machines'

export type RemovalState =
  | { state: 'running'; done: RemovalStep[] }
  | { state: 'failed'; reason: string }
  | { state: 'finished' }
  | { state: 'none' }

export interface PersonInstance {
  name?: string
  status: 'waiting' | 'joined' | 'installing' | 'ready' | 'failed'
  detail?: string
  url: string
  version?: string
  versionWithdrawn?: boolean
  heldByData?: { version: string; needs: number }
  autoUpdates?: boolean
  unreachableSince?: string
  signOutsUndelivered?: { since: string; why: string }
}

export interface PersonEntry {
  id: string
  email: string
  operator: boolean
  createdAt: string
  instance?: PersonInstance
  removal?: {
    startedAt: string
    requestedBy: string
    state: RemovalState
    steps?: RemovalStep[]
    koala?: DeletionProgress
    koalaAway?: { machine?: string; since?: string }
    machinesAway?: { machine: string; since: string }[]
  }
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
  deletedProjects?: number
}

export interface RemovalRefusal {
  error: string
  blockers?: string[]
}

export interface Proof {
  password?: string
  code?: string
}

export interface PasswordReset {
  reset: string
  devCode?: string
}

export interface TwoFactorChange {
  enabled: boolean
  phone?: string
  preferredMethod?: 'email' | 'sms'
}

export interface TwoFactorSaved {
  twoFactorEnabled: boolean
  twoFactorPhone?: string
  twoFactorPreferredMethod?: 'email' | 'sms'
  confirmWith: 'two-factor' | 'password' | 'email-code'
}
