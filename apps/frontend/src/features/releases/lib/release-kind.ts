import type { OdooRelease } from '../api/releases'

export type ReleaseKind =
  | { kind: 'new-code' }
  | { kind: 'again'; of?: string | undefined }
  | { kind: 'same-image'; as: string }

export function releaseKind(release: OdooRelease, releases: readonly OdooRelease[]): ReleaseKind {
  const earlier = releases.filter((other) => other.id !== release.id && other.startedAt < release.startedAt)
  if (release.again) return { kind: 'again', of: releases.find((other) => other.id === release.again)?.commit }
  const same = earlier.filter((other) => other.image === release.image).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]
  return same ? { kind: 'same-image', as: same.commit } : { kind: 'new-code' }
}
