/**
 * ── DUPLICATED, KNOWINGLY ── `SignalView` in apps/backend/src/engine/lib/poisoning.ts is the authority.
 */
export type SignalKind = 'private-out' | 'unvouched-host' | 'canary' | 'memory-from-outside' | 'hidden-in-repo'
export type SignalSeverity = 'certain' | 'high' | 'medium' | 'low'
export type SignalState = 'open' | 'dismissed' | 'resolved'

export interface SignalView {
  id: string
  kind: SignalKind
  severity: SignalSeverity
  state: SignalState
  at: string
  runId: string
  agentSlug?: string
  tool: string
  said: string
  matched?: string
  host?: string
  path?: string
  conversationId?: string
  projectId?: string
  dismissedBecause?: string
}
