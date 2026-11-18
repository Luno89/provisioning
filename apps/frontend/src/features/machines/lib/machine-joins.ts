import type { MachineJoinView } from '@koala/engine-core/machine-join'

export type JoinStatus = 'joining' | 'failed' | 'stopped'

export function joinStatus(join: MachineJoinView, now: Date): JoinStatus {
  if (join.state === 'failed') return 'failed'
  return join.expiresAt > now.toISOString() ? 'joining' : 'stopped'
}
