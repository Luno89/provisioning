import { describe, expect, expectTypeOf, it } from 'vitest'
import { type AppHealthView, type ClusterHealthView, type HistoryState, type Overview, getAlerts, getAppHealth, getClusterHealth, getOverview, removeAlertRule, setHistoryDays } from './monitoring'
import { type ClusterContents, type InfrastructureOverview, type KoalaView, type WorkFailure, clearFailures, getClusterContents, getInfrastructure, getKoala } from '../../infrastructure/api/infrastructure'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import { infrastructureOf, type Infrastructure } from '../../../test/backend/infrastructure'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { monitoringRouter } from '../../../../../backend/src/monitoring/routes/monitoring'
import { infrastructureRouter } from '../../../../../backend/src/infrastructure/routes/infrastructure'
import { RunningService } from '../../../../../backend/src/infrastructure/services/RunningService'
import { WorkFailureService } from '../../../../../backend/src/infrastructure/services/WorkFailureService'
import { ClusterContentsService } from '../../../../../backend/src/infrastructure/services/ClusterContentsService'
import { InfrastructureViewService, type InfrastructureOverview as BackendOverview } from '../../../../../backend/src/infrastructure/services/InfrastructureViewService'
import { TemporalBridge } from '../../../../../backend/src/infrastructure/services/TemporalBridge'
import { PoisoningService } from '../../../../../backend/src/engine/services/PoisoningService'
import { labelValue } from '../../../../../backend/src/engine-host/sandboxes/workspace'
import { decryptValue } from '../../../../../backend/src/platform/lib/crypto'
import type { WorkFailure as BackendWorkFailure } from '../../../../../backend/src/infrastructure/lib/work-failures'
import type { ClusterContents as BackendClusterContents } from '../../../../../backend/src/infrastructure/services/ClusterContentsService'
import type { AppHealthView as BackendAppHealth, ClusterHealthView as BackendClusterHealth, HistoryState as BackendHistoryState, KoalaView as BackendKoalaView, Overview as BackendMonitoringOverview } from '../../../../../backend/src/monitoring/services/MonitoringService'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

let infra: Infrastructure | undefined

const backend = await startBackend(async (site) => {
  const { db } = site
  infra = await infrastructureOf(site)
  const monitoring = infra.monitoring
  const unreachable = new TemporalBridge(db, undefined, DATA_KEY)
  const running = new RunningService(outsideThisTier<ConstructorParameters<typeof RunningService>[0]>('what runs', {
    workflows: { list: async () => undefined, waiting: async () => undefined, cancel: (workflowId) => unreachable.cancelWorkflow(workflowId) },
  }))
  const failures = new WorkFailureService({
    store: db.infrastructure,
    workflows: { describeRun: async () => undefined },
    records: outsideThisTier('what a failure was about'),
    accounts: db.accounts,
    log: (message) => console.warn(message),
  })
  const contents = new ClusterContentsService({
    monitoring,
    deployments: () => db.infrastructure.getDeployments(),
    kubectl: async () => { throw new Error('kubectl reaches a cluster, which the integration tier never does') },
    helm: async () => { throw new Error('helm reaches a cluster, which the integration tier never does') },
    labelOf: labelValue,
  })
  const poisoning = new PoisoningService({
    store: db.engine,
    memories: { list: (ownerId) => db.memory.getMemories(ownerId), save: (item) => db.memory.saveMemory(item) },
    unseal: (sealed) => decryptValue(sealed, DATA_KEY),
  })
  site.api.use('/monitoring', monitoringRouter({ monitoring }))
  site.api.use('/infrastructure', infrastructureRouter({
    infrastructure: new InfrastructureViewService({ monitoring, contents, running, failures, signals: { open: (ownerId) => poisoning.list(ownerId, { open: true }) } }),
  }))
})

const owner = await backend.signIn()
await backend.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: owner.id, machineId: 'desk' })
await backend.db.infrastructure.addWorkFailure({ id: 'failure-1', ownerId: owner.id, workflowId: 'run-1', kind: 'chat', title: 'A chat turn', opens: { kind: 'chat', id: 'chat-1' }, reason: 'the model went away', failedAt: new Date().toISOString() })
await backend.db.infrastructure.addWorkFailure({ id: 'failure-2', ownerId: owner.id, workflowId: 'run-2', kind: 'chat', title: 'Another chat turn', opens: { kind: 'chat', id: 'chat-1' }, reason: 'the model went away', failedAt: new Date().toISOString() })

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads monitoring, Koala\'s own health and the Infrastructure page as the backend describes them', () => {
    expectTypeOf<Wire<BackendMonitoringOverview>>().toExtend<Overview>()
    expectTypeOf<Wire<BackendHistoryState>>().toExtend<HistoryState>()
    expectTypeOf<Wire<BackendAppHealth>>().toExtend<AppHealthView>()
    expectTypeOf<Wire<BackendClusterHealth>>().toExtend<ClusterHealthView>()
    expectTypeOf<Wire<BackendKoalaView>>().toExtend<KoalaView>()
    expectTypeOf<Wire<BackendClusterContents>>().toExtend<ClusterContents>()
    expectTypeOf<Wire<BackendWorkFailure>>().toExtend<WorkFailure>()
    expectTypeOf<Wire<BackendOverview>>().toExtend<InfrastructureOverview>()
  })
})

describe('Infrastructure, with a machine that is stopped and no cluster that answers', () => {
  it('reads the overview: the machine stopped rather than unreachable, what failed, and why what runs cannot be read', async () => {
    const overview = await getInfrastructure()
    expect(overview.failures.map((failure) => failure.id).sort()).toEqual(['failure-1', 'failure-2'])
    expect(overview).toMatchObject({ running: 0, runningProblem: 'Temporal is not reachable, so what runs cannot be read', waiting: [], signals: [] })
    expect(overview.monitoring.clusters).toEqual(arrayWith([objectWith({ id: 'machine-desk' })]))
  })

  it('reads the machine\'s contents as not reachable, saying it is stopped', async () => {
    expect(await getClusterContents('machine-desk')).toMatchObject({ clusterId: 'machine-desk', reachable: false, problem: 'it is stopped', workloads: [] })
  })

  it('answers 404 for contents of a cluster that is not the person\'s', async () => {
    await expect(getClusterContents('nowhere')).rejects.toMatchObject({ response: { status: 404, data: { error: 'no such cluster' } } })
  })

  it('clears one failure, then the rest', async () => {
    expect(await clearFailures(['failure-1'])).toBe(1)
    expect(await clearFailures()).toBe(1)
    expect((await getInfrastructure()).failures).toEqual([])
  })

  it('reads Koala\'s own health with a state and the lines the page shows', async () => {
    const koala = await getKoala()
    expect(koala).toMatchObject({ state: anyOf(String), lines: anyOf(Array), checkedAt: anyOf(String) })
  })
})

describe('monitoring, as the health tabs ask for it', () => {
  it('reads the overview and the alerts with nothing firing', async () => {
    expect(await getOverview()).toMatchObject({ firing: [] })
    expect(await getAlerts()).toEqual({ firing: [], episodes: [], rules: [] })
  })

  it('reads the stopped machine\'s health', async () => {
    expect(await getClusterHealth('machine-desk', '24h')).toMatchObject({ firing: [], lines: anyOf(Array) })
  })

  it('answers 404 for an app or cluster that is not the person\'s', async () => {
    await expect(getAppHealth('nothing', '1h')).rejects.toMatchObject({ response: { status: 404, data: { error: 'no such app' } } })
    await expect(getClusterHealth('nowhere', '7d')).rejects.toMatchObject({ response: { status: 404, data: { error: 'no such cluster' } } })
  })

  it('refuses a history length it cannot keep, and a machine\'s, which is kept with Koala\'s own', async () => {
    await expect(setHistoryDays('machine-desk', -3)).rejects.toMatchObject({ response: { status: 400 } })
    await expect(setHistoryDays('machine-desk', 30)).rejects.toMatchObject({ response: { status: 409, data: { error: 'a machine\'s history is kept with this Koala\'s own, for as long as its system cluster keeps it' } } })
  })

  it('answers 404 for an alert rule that is not the person\'s', async () => {
    await expect(removeAlertRule('none')).rejects.toMatchObject({ response: { status: 404 } })
  })
})
