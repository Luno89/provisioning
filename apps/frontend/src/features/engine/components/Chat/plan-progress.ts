import type { PlanProposal } from '@koala/harness-types'
import type { TreeAsk, TreeRunStatus } from '../../../projects'
import { blockedBy, isAwaitingReview, stateFor, type Leaf } from '../../../projects'

export type PlanStepState = 'done' | 'running' | 'waiting' | 'queued' | 'failed'

export interface PlanStep {
  label: string
  state: PlanStepState
  detail?: string | undefined
  story?: { treeId: string; branchId: string; leafId: string } | undefined
}

export interface PlanProgress {
  steps: PlanStep[]
  done: boolean
  ready?: string | undefined
}

export function followedStories(proposal: PlanProposal): string[] {
  const ids = new Set(Object.values(proposal.adopted?.leafIds ?? {}))
  if (proposal.change?.edit) ids.add(proposal.change.edit.leafId)
  if (proposal.leafPlan) ids.add(proposal.leafPlan.leafId)
  return [...ids]
}

export function plansTree(proposal: PlanProposal, leaves: readonly Leaf[], branches: readonly { id: string; treeId?: string | undefined }[]): string | undefined {
  const known = proposal.adopted?.treeId ?? proposal.change?.treeId
  if (known) return known
  const story = leaves.find((leaf) => followedStories(proposal).includes(leaf.id))
  return story ? branches.find((branch) => branch.id === story.branchId)?.treeId : undefined
}

export interface PlanWork {
  treeId: string | undefined
  leaves: Leaf[]
  run: TreeRunStatus | undefined
  plans: PlanProposal[]
}

function madeLine(proposal: PlanProposal, count: number): string {
  const { change, leafPlan, plan } = proposal
  if (change?.add) return count === 1 ? `Added the story to “${change.add.branchTitle}”` : `Added ${count} stories to “${change.add.branchTitle}”`
  if (change?.edit) return 'Changed the story'
  if (leafPlan) return `Broke down “${leafPlan.leafTitle}” into ${leafPlan.tasks.length} task${leafPlan.tasks.length === 1 ? '' : 's'}`
  if (plan?.tree) return `Made the tree “${plan.tree.name}” with ${count} stor${count === 1 ? 'y' : 'ies'}`
  return `Added ${count} stor${count === 1 ? 'y' : 'ies'}`
}

const SETTLED = new Set(['verified', 'failed', 'cancelled'])

function storyStep(leaf: Leaf, all: Leaf[], treeId: string, running: boolean, breakdownWaiting: boolean, asked: TreeAsk | undefined): PlanStep & { settled: string | undefined } {
  const name = `“${leaf.title}”`
  const story = { treeId, branchId: leaf.branchId, leafId: leaf.id }
  if (leaf.status === 'cancelled') return { label: `${name} was cancelled`, state: 'done', settled: 'cancelled' }
  const state = stateFor(leaf, all)
  if (state === 'verified') return { label: `${name} is verified`, state: 'done', story, settled: 'verified' }
  if (state === 'failed') {
    const last = leaf.attempts?.at(-1)?.error
    return { label: `${name} failed`, state: 'failed', ...(last ? { detail: last } : {}), story, settled: 'failed' }
  }
  if (asked) return { label: `${name} waits for you`, state: 'waiting', detail: `to allow ${asked.agent ?? 'its run'} to run ${asked.tool}`, story, settled: undefined }
  if (state === 'running') return { label: `${name} is being worked`, state: 'running', story, settled: undefined }
  if (state === 'claimed') {
    return isAwaitingReview(leaf)
      ? { label: `${name} is claimed`, state: 'waiting', detail: 'its claim waits for your review', story, settled: undefined }
      : { label: `${name} is claimed`, state: 'running', detail: 'being checked', story, settled: undefined }
  }
  if (breakdownWaiting) return { label: `${name} is broken down`, state: 'waiting', detail: 'the breakdown waits for your approval', story, settled: undefined }
  if (state === 'blocked') {
    if (leaf.waitingFor) return { label: `${name} is blocked`, state: leaf.waitingFor.stuck ? 'failed' : 'queued', detail: leaf.waitingFor.stuck ?? leaf.waitingFor.reason, story, settled: undefined }
    const on = blockedBy(leaf, all).map((other) => `“${other.title}”`).join(', ')
    return { label: `${name} waits`, state: 'queued', detail: `until ${on} is done`, story, settled: undefined }
  }
  const unplanned = (leaf.tasks ?? []).length === 0
  if (!running) return { label: `${name} waits`, state: 'waiting', detail: 'until the tree is run', story, settled: undefined }
  return { label: `${name} waits its turn`, state: 'queued', ...(unplanned ? { detail: 'the planner breaks it down first' } : {}), story, settled: undefined }
}

function readyLine(settled: string[]): string {
  const verified = settled.filter((state) => state === 'verified').length
  const failed = settled.filter((state) => state === 'failed').length
  const cancelled = settled.filter((state) => state === 'cancelled').length
  if (verified === settled.length) return settled.length === 1 ? 'The story is verified' : `All ${settled.length} stories are verified`
  return [
    verified > 0 ? `${verified} verified` : '',
    failed > 0 ? `${failed} failed` : '',
    cancelled > 0 ? `${cancelled} cancelled` : '',
  ].filter(Boolean).join(', ')
}

export function planProgress(proposal: PlanProposal, { treeId, leaves, run, plans }: PlanWork): PlanProgress | undefined {
  const ids = followedStories(proposal)
  if (proposal.status !== 'adopted' || !treeId || ids.length === 0) return undefined
  const followed = ids.map((id) => leaves.find((leaf) => leaf.id === id)).filter((leaf): leaf is Leaf => leaf !== undefined)
  const running = run?.state === 'running'
  const waitingBreakdown = new Set(plans.filter((plan) => plan.status === 'proposed' && plan.leafPlan).map((plan) => plan.leafPlan!.leafId))

  const asked = new Map((run?.state === 'running' ? run.asking ?? [] : []).filter((ask) => ask.leafId).map((ask) => [ask.leafId!, ask]))
  const stories = followed.map((leaf) => storyStep(leaf, leaves, treeId, running, waitingBreakdown.has(leaf.id), asked.get(leaf.id)))
  const settled = stories.map((step) => step.settled)
  const done = followed.length === ids.length && settled.every((state) => state !== undefined && SETTLED.has(state))
  const steps: PlanStep[] = [
    { label: madeLine(proposal, ids.length), state: 'done' },
    ...stories.map(({ settled: _settled, ...step }) => step),
  ]
  return { steps, done, ...(done ? { ready: readyLine(settled as string[]) } : {}) }
}
