import { describe, expect, expectTypeOf, it } from 'vitest'
import { type RunningItem, type RunningView, cancelRunning, getRunning, pauseBench, pauseKeeper } from './running'
import { type TemporalStatus, type WorkflowSummary, cancelWorkflow, getTemporalStatus, getWorkflowCount, listWorkflows } from './temporal'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { runningRouter } from '../../../../../backend/src/infrastructure/routes/running'
import { temporalRouter } from '../../../../../backend/src/infrastructure/routes/temporal'
import { RunningService, type RunningView as BackendRunningView } from '../../../../../backend/src/infrastructure/services/RunningService'
import { TemporalBridge } from '../../../../../backend/src/infrastructure/services/TemporalBridge'
import { BenchService, type BenchDeps } from '../../../../../backend/src/checks/services/BenchService'
import { MemoryKeeperService } from '../../../../../backend/src/memory/services/MemoryKeeperService'
import type { RunningItem as BackendRunningItem } from '../../../../../backend/src/infrastructure/lib/running'
import { anyOf } from '../../../../../backend/src/platform/lib/test-matchers'
import type { TemporalReach, WorkflowSummary as BackendWorkflowSummary } from '../../../../../backend/src/infrastructure/services/TemporalBridge'

const idleTimers: { ownerId: string; idleMs: number }[] = []

const backend = await startBackend(({ api, db }) => {
  const unreachable = new TemporalBridge(db, undefined, DATA_KEY)
  const bench = new BenchService(outsideThisTier<BenchDeps>('the bench', {
    store: db,
    idleTimer: async (ownerId, idleMs) => { idleTimers.push({ ownerId, idleMs }) },
    now: () => Date.now(),
  }))
  const keeper = new MemoryKeeperService(outsideThisTier<ConstructorParameters<typeof MemoryKeeperService>[0]>('the memory keeper', { store: db, now: () => new Date().toISOString() }))
  const running = new RunningService({
    workflows: {
      list: async () => {
        if (!unreachable.isReady()) return undefined
        throw new Error('a ready Temporal is outside this tier')
      },
      waiting: async () => undefined,
      cancel: (workflowId) => unreachable.cancelWorkflow(workflowId),
    },
    records: outsideThisTier('what runs is about, which is read only once Temporal answers'),
    checks: outsideThisTier('checks'),
    trees: outsideThisTier('trees'),
    runs: outsideThisTier('runs'),
    bench: { settings: (ownerId) => bench.settings(ownerId), saveSettings: (ownerId, value) => bench.saveSettings(ownerId, value) },
    keeper,
  })
  api.use('/running', runningRouter({ running }))
  api.use('/temporal', temporalRouter({ temporalBridge: unreachable }))
})

const owner = await backend.signIn()

expectTypeOf<Wire<BackendRunningItem>>().toExtend<RunningItem>()
expectTypeOf<Wire<BackendRunningView>>().toExtend<RunningView>()
expectTypeOf<Wire<BackendWorkflowSummary>>().toExtend<WorkflowSummary>()
expectTypeOf<Wire<TemporalReach>>().toExtend<TemporalStatus>()

describe('Running, while Temporal cannot be reached', () => {
  it('says what runs cannot be read, with 503 and why', async () => {
    await expect(getRunning()).rejects.toMatchObject({ response: { status: 503, data: { error: 'Temporal is not reachable, so what runs cannot be read' } } })
  })

  it('says work cannot be cancelled, with 503 and why, rather than that nothing runs', async () => {
    await expect(cancelRunning('anything')).rejects.toMatchObject({ response: { status: 503, data: { error: 'Temporal is not reachable, so what runs cannot be cancelled' } } })
  })

  it('pauses the bench and starts it again, its idle count starting once it is on', async () => {
    expect(await pauseBench(true)).toEqual({ paused: true })
    expect(await pauseBench(false)).toEqual({ paused: false })
    expect(idleTimers).toEqual([{ ownerId: owner.id, idleMs: anyOf(Number) }])
  })

  it('pauses the memory keeper and says how many conclusions it holds', async () => {
    expect(await pauseKeeper(true)).toMatchObject({ paused: true, held: 0 })
    expect(await pauseKeeper(false)).toMatchObject({ paused: false, held: 0 })
  })
})

describe('All workflows, while Temporal cannot be reached', () => {
  it('reads Temporal as not connected', async () => {
    expect(await getTemporalStatus()).toEqual({ connected: false, reason: 'the backend has not connected to Temporal yet' })
  })

  it('refuses the workflow list and counts with 503 and why', async () => {
    await expect(listWorkflows()).rejects.toMatchObject({ response: { status: 503, data: { error: 'Temporal is not reachable' } } })
    await expect(getWorkflowCount('mine')).rejects.toMatchObject({ response: { status: 503, data: { error: 'Temporal is not reachable' } } })
    await expect(cancelWorkflow('anything')).rejects.toMatchObject({ response: { status: 503 } })
  })
})
