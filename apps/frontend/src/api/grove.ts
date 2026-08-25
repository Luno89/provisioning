import { api } from './client'
import type { Tree, Branch, Leaf, TreeType } from '../types/grove'

/**
 * The Grove — trees, branches, leaves and the tree types that describe them.
 *
 * ── ONE MODULE, FOUR PREFIXES ──
 * The backend has four routers here (`trees`, `branches`, `leaves`, `tree-types`) and this is one
 * module, which is a deliberate departure from the usual one-to-one. They are not four domains:
 * a leaf is meaningless without its branch, the Grove screen reads all four in one breath, and
 * splitting them would mean four imports at every call site to describe one thing.
 *
 * `harness/` went the other way for the opposite reason — six genuinely independent sub-resources
 * that different panels use in isolation.
 *
 * ── TREE TYPES ARE DATA ──
 * `tree-types` is a READ here and nothing else. What a tree type means — which personas it needs,
 * whether it requires a repo — is a database record the user edits, never a literal in this
 * codebase. A hardcoded list here would be exactly the thing the tree-types work removed.
 */

export const groveKeys = {
  trees: () => ['trees'] as const,
  branches: () => ['branches'] as const,
  leaves: () => ['leaves'] as const,
  treeTypes: () => ['tree-types'] as const,
  trace: (id: string) => ['leaf-trace', id] as const,
}

export const listTrees = (): Promise<Tree[]> => api.get<Tree[]>('/trees').then((r) => r.data)
export const createTree = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/trees', body).then((r) => r.data)
export const deleteTree = (id: string) => api.delete(`/trees/${id}`).then((r) => r.data)

export const listBranches = (): Promise<Branch[]> =>
  api.get<Branch[]>('/branches').then((r) => r.data)
export const createBranch = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/branches', body).then((r) => r.data)

/**
 * Patches a branch. Only the acceptance checks are edited this way today — they are the criteria a
 * leaf is judged against, and changing them is a decision about THIS effort rather than a global
 * setting.
 */
export const patchBranch = (id: string, patch: Record<string, unknown>) =>
  api.patch(`/branches/${id}`, patch).then((r) => r.data)
export const deleteBranch = (id: string) => api.delete(`/branches/${id}`).then((r) => r.data)

export const listLeaves = (): Promise<Leaf[]> => api.get<Leaf[]>('/leaves').then((r) => r.data)
export const deleteLeaf = (id: string) => api.delete(`/leaves/${id}`).then((r) => r.data)

/**
 * Patches a leaf in place. Today only the token budget is raised this way — a leaf that stopped on
 * `finish_reason: length` did the work and ran out of room, which is a different event from
 * failing it, and doubling the budget is the one-click answer to it.
 */
export const patchLeaf = (id: string, patch: Record<string, unknown>) =>
  api.patch(`/leaves/${id}`, patch).then((r) => r.data)

/** The full execution trace for one leaf — every step the agent took, fetched on demand. */
export const getLeafTrace = (id: string) => api.get(`/leaves/${id}/trace`).then((r) => r.data)

/**
 * The five verbs a leaf accepts.
 *
 * `retry` and `recheck` are NOT the same: retry runs the work again, recheck re-evaluates the
 * existing result against the acceptance criteria. A leaf that failed review because the criteria
 * were wrong wants recheck; one that failed because the work was wrong wants retry. Collapsing
 * them would silently burn a real run.
 */
export const acceptLeaf = (id: string, body?: unknown) =>
  api.post(`/leaves/${id}/accept`, body ?? {}).then((r) => r.data)
export const cancelLeaf = (id: string) => api.post(`/leaves/${id}/cancel`, {}).then((r) => r.data)
export const retryLeaf = (id: string, body?: unknown) =>
  api.post(`/leaves/${id}/retry`, body ?? {}).then((r) => r.data)
/**
 * Re-evaluates an existing result against the acceptance criteria, without running the work again.
 *
 * `changed` is the field that matters: a recheck that flips the verdict invalidates the board, and
 * one that confirms it should not.
 */
export const recheckLeaf = (id: string): Promise<{ outcome: string; reason: string; changed?: boolean }> =>
  api.post<{ outcome: string; reason: string; changed?: boolean }>(`/leaves/${id}/recheck`, {})
    .then((r) => r.data)
/**
 * Opens a review conversation about a failed leaf, and returns where it landed.
 *
 * The caller navigates into that branch with the prompt — which is what puts the EVIDENCE in a
 * transcript rather than only the conclusion.
 */
export const reviewLeaf = (id: string): Promise<{ branchId: string; prompt: string }> =>
  api.post<{ branchId: string; prompt: string }>(`/leaves/${id}/review`, {}).then((r) => r.data)

export const listTreeTypes = (): Promise<TreeType[]> =>
  api.get<TreeType[]>('/tree-types').then((r) => r.data)
