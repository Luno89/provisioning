import { describe, it, expect } from 'vitest'
import type { PlanProposal } from '@koala/harness-types'
import type { Leaf } from '../leaf-types'
import { planProgress, plansTree } from './plan-progress'

const added: PlanProposal = {
  id: 'p1', ownerId: 'u1', status: 'adopted', createdAt: 'a', updatedAt: 'a',
  change: { treeId: 't1', why: 'w', add: { branchId: 'b1', branchTitle: 'The proof', leaves: [] }, before: [], outcome: [] },
  adopted: { treeId: 't1', branchIds: ['b1'], leafIds: { persist: 'l1', slip: 'l2' }, taskIds: {} },
}

const leaf = (over: Partial<Leaf>): Leaf => ({ id: 'l1', branchId: 'b1', title: 'Persists', status: 'pending', tasks: ['t'], updatedAt: 'a', ...over })
const running = { state: 'running' as const, startedAt: 'a' }

describe('following an approved plan', () => {
  it('says what was added, then where each story stands, with a way to open it', () => {
    const progress = planProgress(added, {
      treeId: 't1',
      leaves: [leaf({ status: 'running' }), leaf({ id: 'l2', title: 'Slip', tasks: [] })],
      run: running,
      plans: [],
    })
    expect(progress).toEqual({
      done: false,
      steps: [
        { label: 'Added 2 stories to “The proof”', state: 'done' },
        { label: '“Persists” is being worked', state: 'running', story: { treeId: 't1', branchId: 'b1', leafId: 'l1' } },
        { label: '“Slip” waits its turn', state: 'queued', detail: 'the planner breaks it down first', story: { treeId: 't1', branchId: 'b1', leafId: 'l2' } },
      ],
    })
  })

  it('says when the person is wanted: a breakdown to approve, a claim to review, a tree nobody runs', () => {
    const claimed = leaf({ status: 'claimed', claim: { evidence: 'e', at: '2' }, review: { verdict: 'concern', at: '3' } })
    const progress = planProgress(added, { treeId: 't1', leaves: [claimed, leaf({ id: 'l2', title: 'Slip', tasks: [] })], run: running, plans: [{ ...added, id: 'p2', status: 'proposed', change: undefined, adopted: undefined, leafPlan: { treeId: 't1', leafId: 'l2', leafTitle: 'Slip', mode: 'breakdown', why: 'w', brief: 'b', tasks: [] } }] })
    expect(progress?.steps.slice(1).map((step) => [step.state, step.detail])).toEqual([
      ['waiting', 'its claim waits for your review'],
      ['waiting', 'the breakdown waits for your approval'],
    ])
    const idle = planProgress(added, { treeId: 't1', leaves: [leaf({}), leaf({ id: 'l2', title: 'Slip' })], run: { state: 'none' }, plans: [] })
    expect(idle?.steps[1]).toMatchObject({ state: 'waiting', detail: 'until the tree is run' })
  })

  it('says when a story\'s run waits for you to allow a call', () => {
    const asking = { ...running, asking: [{ runId: 'r', callId: 'c1', tool: 'delete_project', message: 'm', agent: 'executor', leafId: 'l1' }] }
    const progress = planProgress(added, { treeId: 't1', leaves: [leaf({ status: 'running' }), leaf({ id: 'l2', title: 'Slip', status: 'running' })], run: asking, plans: [] })
    expect(progress?.steps.slice(1).map((step) => [step.label, step.state, step.detail])).toEqual([
      ['“Persists” waits for you', 'waiting', 'to allow executor to run delete_project'],
      ['“Slip” is being worked', 'running', undefined],
    ])
  })

  it('says what a story waits on, and when its workspace build is stuck', () => {
    const progress = planProgress(added, {
      treeId: 't1',
      leaves: [leaf({ dependsOn: ['l0'] }), leaf({ id: 'l0', title: 'The form', status: 'running' }), leaf({ id: 'l2', title: 'Slip', waitingFor: { reason: 'r', since: 's', stuck: 'the build failed' } })],
      run: running,
      plans: [],
    })
    expect(progress?.steps.slice(1).map((step) => [step.label, step.state, step.detail])).toEqual([
      ['“Persists” waits', 'queued', 'until “The form” is done'],
      ['“Slip” is blocked', 'failed', 'the build failed'],
    ])
  })

  it('is done once every story is verified, failed or cancelled, and says how it ended', () => {
    const verified = planProgress(added, { treeId: 't1', leaves: [leaf({ status: 'succeeded', verified: true }), leaf({ id: 'l2', title: 'Slip', status: 'succeeded', verified: true })], run: { state: 'none' }, plans: [] })
    expect(verified).toMatchObject({ done: true, ready: 'All 2 stories are verified' })
    const mixed = planProgress(added, { treeId: 't1', leaves: [leaf({ status: 'failed', attempts: [{ attempt: 1, error: 'the spec timed out', failedAt: 'a' }] }), leaf({ id: 'l2', title: 'Slip', status: 'cancelled' })], run: { state: 'none' }, plans: [] })
    expect(mixed).toMatchObject({ done: true, ready: '1 failed, 1 cancelled' })
    expect(mixed?.steps[1]).toMatchObject({ label: '“Persists” failed', state: 'failed', detail: 'the spec timed out' })
  })

  it('follows nothing until it is adopted, or when it touched no story', () => {
    expect(planProgress({ ...added, status: 'adopting' }, { treeId: 't1', leaves: [], run: undefined, plans: [] })).toBeUndefined()
    expect(planProgress({ ...added, adopted: { ...added.adopted!, leafIds: {} } }, { treeId: 't1', leaves: [], run: undefined, plans: [] })).toBeUndefined()
  })

  it('finds a breakdown\'s tree through its story', () => {
    const breakdown: PlanProposal = { id: 'p3', ownerId: 'u1', status: 'adopted', createdAt: 'a', updatedAt: 'a', leafPlan: { treeId: 't1', leafId: 'l2', leafTitle: 'Slip', mode: 'breakdown', why: 'w', brief: 'b', tasks: [] } }
    expect(plansTree(breakdown, [leaf({ id: 'l2', branchId: 'b1' })], [{ id: 'b1', treeId: 't1' }])).toBe('t1')
  })
})
