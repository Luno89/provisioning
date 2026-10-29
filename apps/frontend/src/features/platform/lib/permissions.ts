/*
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `SESSION_PERMISSIONS` in `apps/backend/src/platform/lib/permissions.ts`, which is the authority: the server
 * works out each one with `authorize` and sends the answers on `/api/auth/me`. Kept in sync by hand.
 */
export const SESSION_PERMISSIONS = ['administer', 'manage-accounts', 'see-all-work', 'open-platform-namespaces', 'change-instance-settings', 'manage-own-account'] as const

export type SessionPermission = typeof SESSION_PERMISSIONS[number]

export type SessionPermissions = Partial<Record<SessionPermission, boolean>>

export interface Permitted<A extends string> {
  can?: readonly A[] | undefined
}

export const canDo = (permissions: SessionPermissions | undefined, action: SessionPermission): boolean =>
  permissions?.[action] === true

export const canOn = <A extends string>(record: Permitted<A> | undefined, action: A): boolean =>
  record?.can?.includes(action) === true
