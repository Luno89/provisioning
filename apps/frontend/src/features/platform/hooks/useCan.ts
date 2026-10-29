import { useCallback } from 'react'
import { useShellStore } from '../stores/shell'
import { canDo, canOn, type Permitted, type SessionPermission } from '../lib/permissions'

export interface Can {
  (action: SessionPermission): boolean
  <A extends string>(action: A, record: Permitted<A> | undefined): boolean
}

export function useCan(): Can {
  const permissions = useShellStore((s) => s.user?.permissions)
  return useCallback(
    (action: string, ...record: [Permitted<string> | undefined] | []) =>
      record.length === 0 ? canDo(permissions, action as SessionPermission) : canOn(record[0], action),
    [permissions],
  ) as Can
}
