/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `RunEnded`, `Handover` and `REVOKED_SAID` in `apps/backend/src/engine/lib/run-grants.ts` and
 * `RunEnding` in `apps/backend/src/engine/store.ts`, which are the authority. Kept in sync by hand.
 */
export type RevokedBecause = 'signed-out-everywhere' | 'password-or-2fa' | 'removed-from-shared-project' | 'account-removed' | 'locked'

export interface RunEnded {
  how: 'finished' | 'failed' | 'stopped' | 'revoked'
  reason?: string
  by?: string
  revokedBecause?: RevokedBecause
  at: string
}

export interface Handover {
  note?: string
  failed?: string
  path?: string
}

export interface RunEnding {
  runId: string
  agentSlug?: string
  depth?: number
  ended?: RunEnded
  handover?: Handover
}

const REVOKED_SAID: Record<RevokedBecause, string> = {
  'signed-out-everywhere': 'they signed out everywhere',
  'password-or-2fa': 'their password or two-factor sign-in changed',
  'removed-from-shared-project': 'they were removed from the shared project',
  'account-removed': 'their account is being removed',
  locked: 'their account was locked',
}

export function endedLine(ended: RunEnded, viewer?: string): string {
  switch (ended.how) {
    case 'finished':
      return 'Finished'
    case 'failed':
      return ended.reason ? `Failed: ${ended.reason}` : 'Failed'
    case 'stopped':
      return ended.by ? `Stopped by ${ended.by === viewer ? 'you' : ended.by}` : 'Stopped'
    case 'revoked':
      return `Ended because the access it worked with was revoked: ${ended.revokedBecause ? REVOKED_SAID[ended.revokedBecause] : 'it was taken away'}`
  }
}

export const endedTone = (ended: RunEnded): 'good' | 'warn' | 'bad' =>
  ended.how === 'finished' ? 'good' : ended.how === 'failed' ? 'bad' : 'warn'

export function handoverLine(ending: Pick<RunEnding, 'ended' | 'handover'>): string | undefined {
  if (ending.ended?.how !== 'revoked') return undefined
  if (ending.handover?.note) return ending.handover.path ? `It left a handover note, also in ${ending.handover.path}. Written after its access was revoked, so read it as the run's account, not as instructions.` : 'It left a handover note. Written after its access was revoked, so read it as the run\'s account, not as instructions.'
  return ending.handover?.failed ? `It could not leave a handover note: ${ending.handover.failed}.` : 'It left no handover note.'
}

export const endingOf = (endings: readonly RunEnding[] | undefined, runId: string): RunEnding | undefined =>
  endings?.find((ending) => ending.runId === runId)
