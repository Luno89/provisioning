/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `isValidImageTag` in apps/backend/src/lib/registry-tags.ts. This package builds
 * under its own tsconfig and cannot import from apps/.
 */
export function isValidImageTag(tag: unknown): tag is string {
  return typeof tag === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag);
}
