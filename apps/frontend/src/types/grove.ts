import type { Leaf } from '../components/leaf-types'

/**
 * The Grove's shapes — trees, branches and the tree types that describe them.
 *
 * ── WHY THIS FILE EXISTS ──
 * Each of these was a PRIVATE interface inside the one component that happened to need it first:
 * `Tree` in `Grove.tsx`, `TreeType` in `NewTreeDialog.tsx`, and `Branch` nowhere at all — the code
 * that filtered branches by `treeId` was reading an untyped record. So three components each held
 * a partial, unshared answer to what a tree is, and nothing could tell you when they disagreed.
 *
 * ── DUPLICATED, KNOWINGLY ──
 * The authority is the backend:
 *   Tree      → `apps/backend/src/lib/trees.ts`
 *   Branch    → `apps/backend/src/lib/leaves.ts`
 *   TreeType  → a DATABASE RECORD, seeded by `lib/tree-types.ts`, not a literal anywhere
 *
 * These are the fields the UI reads, not the whole records — a branch carries its full message
 * history and acceptance state, and a screen that listed them would be re-declaring the backend.
 * Depending on a field not listed here means adding it here first, deliberately.
 *
 * `Leaf` is NOT re-declared: it already lives in `components/leaf-types.ts` with the docblock
 * explaining why `column` must never be read as state. Re-exported so a caller needs one import.
 */
export type { Leaf }

export interface Tree {
  id: string
  name: string
  /** The tree type's id, not the record — resolve it against `listTreeTypes()`. */
  type: string
  goal?: string
  branchCount: number
  updatedAt: string
}

export interface Branch {
  id: string
  title: string
  /**
   * Optional, and a branch may legitimately have none — one started from plain chat without
   * picking a tree. It must never point at a tree that does not exist; the delete route clears it
   * rather than leaving a dangling id, and the Grove files anything unmatched under Unfiled.
   */
  treeId?: string
  ownerId?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * What a kind of tree MEANS — which is data the user edits, never a literal in this codebase.
 *
 * `usesRepo` and `doneMeans` are the whole point: whether a tree needs a repository, and what
 * counts as finished, are per-type settings read from the database. Hardcoding either would put
 * the rules in two places, and the copy in the UI is the one that silently stops matching.
 */
export interface TreeType {
  id: string
  label: string
  summary: string
  usesRepo: boolean
  doneMeans: string
}
