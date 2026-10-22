import { BOARD_COLUMNS, blockedBy, stateFor, type Leaf, type LeafState } from '../../lib/leaf-types'
import type { EngineTask } from '../../../../api/engine'
import type { OdooRelease } from '../../../../api/releases'
import type { TreeAsk } from '../../api/grove'
import type { PipelineRun } from '../PipelineRunRow'
import type { TreeType } from '../../types/grove'
import { versionLabel } from '../../lib/tree-version'

export type Reached = 'live' | 'preview'

export interface Story {
  leaf: Leaf
  state: LeafState
  waitsOn: string[]
  waitsForWorkspace?: string
  workspaceStuck?: string
  asks?: { tool: string; agent?: string | undefined }
  tasks: { done: number; total: number; proposed: number }
  attempts: number
  reached?: Reached | undefined
}

export interface Feature {
  id: string
  title: string
  priority?: number | undefined
  columns: Record<LeafState, Story[]>
  total: number
}

export interface Epic {
  id: string
  name: string
  version?: string | undefined
  features: Feature[]
  totals: Record<LeafState, number>
  total: number
}

export interface Ranked {
  id: string
  priority?: number | undefined
  createdAt?: string | undefined
}

export function byRank(a: Ranked, b: Ranked): number {
  const first = (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY)
  if (first !== 0 && !Number.isNaN(first)) return first
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
}

export function storiesInOrder(feature: Pick<Feature, 'columns'>): string[] {
  return BOARD_COLUMNS.flatMap((column) => feature.columns[column.id]).map((story) => story.leaf).sort(byRank).map((leaf) => leaf.id)
}

export function storyOrderAfterMove(feature: Pick<Feature, 'columns'>, movedId: string, overId: string): string[] | undefined {
  const order = storiesInOrder(feature)
  const from = order.indexOf(movedId)
  const to = order.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return undefined
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, movedId)
  return next
}

export function featureOrderAfterMove(epic: Pick<Epic, 'features'>, featureId: string, by: -1 | 1): string[] | undefined {
  const order = epic.features.map((feature) => feature.id)
  const from = order.indexOf(featureId)
  const to = from + by
  if (from < 0 || to < 0 || to >= order.length) return undefined
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, featureId)
  return next
}

const emptyColumns = (): Record<LeafState, Story[]> =>
  Object.fromEntries(BOARD_COLUMNS.map((column) => [column.id, []])) as unknown as Record<LeafState, Story[]>

const zero = (): Record<LeafState, number> =>
  Object.fromEntries(BOARD_COLUMNS.map((column) => [column.id, 0])) as unknown as Record<LeafState, number>

export function reachedBy(
  leaf: Pick<Leaf, 'landed' | 'status'>,
  releases: readonly Pick<OdooRelease, 'state' | 'startedAt'>[],
  runs: readonly Pick<PipelineRun, 'startedAt' | 'promotedAt'>[],
): Reached | undefined {
  if (leaf.status !== 'succeeded' || leaf.landed?.outcome !== 'merged') return undefined
  const after = (at: string | undefined) => at !== undefined && at >= leaf.landed!.at
  if (releases.some((release) => release.state === 'live' && after(release.startedAt))) return 'live'
  if (runs.some((run) => run.promotedAt !== undefined && after(run.startedAt))) return 'live'
  if (releases.some((release) => release.state === 'preview' && after(release.startedAt))) return 'preview'
  return undefined
}

export function storyOf(
  leaf: Leaf,
  all: Leaf[],
  tasks: ReadonlyMap<string, Pick<EngineTask, 'status' | 'leafId'>>,
  releases: readonly Pick<OdooRelease, 'state' | 'startedAt'>[],
  runs: readonly Pick<PipelineRun, 'startedAt' | 'promotedAt'>[],
  asked?: Pick<TreeAsk, 'tool' | 'agent'> | undefined,
): Story | undefined {
  const state = stateFor(leaf, all)
  if (!state) return undefined
  const own = (leaf.tasks ?? []).map((id) => tasks.get(id)).filter((task): task is Pick<EngineTask, 'status' | 'leafId'> => task !== undefined && task.status !== 'proposed' && task.status !== 'dropped')
  const proposed = [...tasks.values()].filter((task) => task.leafId === leaf.id && task.status === 'proposed').length
  return {
    leaf,
    state,
    waitsOn: leaf.status === 'pending' ? blockedBy(leaf, all).map((other) => other.title) : [],
    ...(leaf.waitingFor ? { waitsForWorkspace: leaf.waitingFor.reason } : {}),
    ...(leaf.waitingFor?.stuck ? { workspaceStuck: leaf.waitingFor.stuck } : {}),
    ...(asked ? { asks: { tool: asked.tool, ...(asked.agent ? { agent: asked.agent } : {}) } } : {}),
    tasks: { done: own.filter((task) => task.status === 'done').length, total: own.length, proposed },
    attempts: leaf.attempts?.length ?? 0,
    reached: reachedBy(leaf, releases, runs),
  }
}

export function buildBoard(input: {
  trees: readonly { id: string; name: string; type?: string | undefined; version?: string | undefined }[]
  types?: readonly Pick<TreeType, 'id' | 'versions'>[] | undefined
  branches: readonly { id: string; title: string; treeId?: string | undefined; priority?: number | undefined; createdAt?: string | undefined }[]
  leaves: Leaf[]
  tasks?: readonly EngineTask[] | undefined
  releases?: readonly Pick<OdooRelease, 'state' | 'startedAt'>[] | undefined
  runs?: readonly Pick<PipelineRun, 'startedAt' | 'promotedAt'>[] | undefined
  asking?: readonly TreeAsk[] | undefined
}): Epic[] {
  const tasks = new Map((input.tasks ?? []).map((task) => [task.id, task]))
  const asked = new Map((input.asking ?? []).filter((ask) => ask.leafId).map((ask) => [ask.leafId!, ask]))
  return input.trees.map((tree) => {
    const totals = zero()
    const features = input.branches.filter((branch) => branch.treeId === tree.id).sort(byRank).map((branch): Feature => {
      const columns = emptyColumns()
      for (const leaf of input.leaves.filter((candidate) => candidate.branchId === branch.id).sort(byRank)) {
        const story = storyOf(leaf, input.leaves, tasks, input.releases ?? [], input.runs ?? [], asked.get(leaf.id))
        if (!story) continue
        columns[story.state].push(story)
        totals[story.state] += 1
      }
      return { id: branch.id, title: branch.title, ...(branch.priority !== undefined ? { priority: branch.priority } : {}), columns, total: BOARD_COLUMNS.reduce((sum, column) => sum + columns[column.id].length, 0) }
    })
    const version = versionLabel(tree, input.types ?? [])
    return { id: tree.id, name: tree.name, ...(version ? { version } : {}), features, totals, total: features.reduce((sum, feature) => sum + feature.total, 0) }
  })
}

export function featureOnly(epic: Epic, feature: Feature): Epic {
  const totals = zero()
  for (const column of BOARD_COLUMNS) totals[column.id] = feature.columns[column.id].length
  return { ...epic, features: [feature], totals, total: feature.total }
}

export interface ProjectStatus {
  live?: { commit: string; slot?: 'a' | 'b' | undefined; since?: string | undefined } | undefined
  preview?: OdooRelease | undefined
  preparing?: { commit: string } | undefined
  lastBuild?: { status: PipelineRun['status']; commit: string; at: string; skipped?: string | undefined; held?: string | undefined; error?: string | undefined } | undefined
}

export function projectStatus(releases: readonly OdooRelease[], runs: readonly PipelineRun[]): ProjectStatus {
  const newest = <T extends { startedAt: string }>(items: readonly T[]) => [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  const live = newest(releases.filter((release) => release.state === 'live'))
  const deployed = newest(runs.filter((run) => run.promotedAt !== undefined))
  const preview = newest(releases.filter((release) => release.state === 'preview'))
  const preparing = newest(releases.filter((release) => release.state === 'preparing' || release.state === 'cutting-over' || release.state === 'rolling-back'))
  const build = newest(runs)
  return {
    ...(live
      ? { live: { commit: live.commit, slot: live.slot, since: live.liveAt ?? live.updatedAt } }
      : deployed ? { live: { commit: deployed.commitSha, since: deployed.promotedAt } } : {}),
    ...(preview ? { preview } : {}),
    ...(preparing ? { preparing: { commit: preparing.commit } } : {}),
    ...(build ? { lastBuild: { status: build.status, commit: build.commitSha, at: build.finishedAt ?? build.startedAt, skipped: build.releaseSkipped, held: build.releaseHeld, error: build.errorMessage } } : {}),
  }
}

export function withOrder<T extends { id: string; priority?: number | undefined }>(items: readonly T[], order: readonly string[]): T[] {
  const at = new Map(order.map((id, index) => [id, index]))
  return items.map((item) => (at.has(item.id) ? { ...item, priority: at.get(item.id)! } : item))
}
