/**
 * Who may see what.
 *
 * ── WHY THESE ARE HERE AND NOT IN index.ts ──
 * They were in index.ts, and `lib/room-authorization.test.ts` tested a COPY of them — a file that
 * imported nothing but vitest and re-declared the rules it was asserting. That test could not fail
 * no matter what index.ts did, which is the worst possible property for the only automated check on
 * a tenant-isolation rule. It now imports these.
 *
 * The rule was also written three times: `ownsProject` at index.ts, the same expression inlined in
 * `authorizeRoom`'s pipeline-run branch, and the test's copy. Three copies of one security
 * decision is how two of them quietly stop matching.
 *
 * Pure and dependency-free on purpose (see `lib/leaves.ts` for the same shape), so a route, a
 * socket handler and a test all reach the identical decision.
 */

/**
 * The minimum a caller must know about a user to make an ownership decision.
 *
 * These are MINIMUM shapes, and the functions below are generic over them, so a caller can pass a
 * whole `ClusterMetadata` or a whole project row without TypeScript's excess-property check
 * rejecting the literal. Narrowing to the two fields that matter is the point — it means a decision
 * about ownership cannot accidentally start depending on something else on the record.
 */
export interface OwnershipUser {
  id: string;
  isAdmin?: boolean | undefined;
}

/**
 * The minimum an owned record must carry.
 *
 * The index signature is what makes "may carry an ownerId" sayable. Without it, a caller passing a
 * record that has no `ownerId` at all — a legacy project, which is exactly the case the fallback
 * below exists for — has nothing for TypeScript to infer the generic from, so it falls back to this
 * constraint and then rejects every other field as excess.
 */
export interface OwnedRecord {
  ownerId?: string | undefined;
  [key: string]: unknown;
}

/**
 * Whether this user owns this project.
 *
 * ── THE LEGACY BRANCH IS DELIBERATE ──
 * Projects predate the ownership model, so some rows have no `ownerId` at all. The old behaviour
 * was that every user saw every project; falling back to admin-only fails CLOSED, which is the
 * entire point of the fallback.
 *
 * Sharp edge, documented rather than fixed: `ownerId: ''` is falsy, so a corrupt record with an
 * empty owner takes the legacy branch and becomes admin-visible. That is acceptable only because
 * `ownerId` is always set from an authenticated user id and never from request input — if that ever
 * stops being true, this must become an `undefined` check.
 */
export function ownsProject<T extends OwnedRecord>(
  project: T | null | undefined,
  user: OwnershipUser,
): boolean {
  return project?.ownerId ? project.ownerId === user.id : user.isAdmin === true;
}

/**
 * Whether this user may see this cluster.
 *
 * Mirrors `ClusterService.getById`, which is the authority. Both return the same answer for "no
 * such id" and "not yours" on purpose: conflating them means a guessed id cannot be used to confirm
 * that someone else's cluster exists.
 *
 * The system cluster is shared platform infrastructure with no `ownerId`, so it has to bypass the
 * check rather than fail it.
 */
export function clusterVisible<T extends OwnedRecord & { isSystem?: boolean | undefined }>(
  cluster: T | null | undefined,
  userId: string,
): boolean {
  return !!cluster && (cluster.isSystem === true || cluster.ownerId === userId);
}

/**
 * Everything in `records` this user owns.
 *
 * Replaces seven near-identical filter closures that had accumulated in index.ts — `ownedPersonas`,
 * `ownedBranches`, `ownedTrees`, `ownedConversations`, `ownedLeaves` and friends were each one line,
 * and each was one line that could be forgotten on the eighth collection.
 */
export function ownedBy<T extends OwnedRecord>(records: readonly T[], userId: string): T[] {
  return records.filter((r) => r.ownerId === userId);
}
