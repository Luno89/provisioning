import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory } from '@tanstack/react-router'
import App from '../App'
import { createProvisioningRouter } from './router'
import { api } from '../api/client'
import { deployApp, destroyResource, patchDeploymentConfig, setDeploymentModules } from '../features/infrastructure/api/deployments'
import { EMPTY_WIZARD_DATA } from '../features/infrastructure/lib/wizard-defaults'
import { deployPayloadOf } from '../features/infrastructure/lib/deploy-payload'
import { startBackend } from '../test/backend/site'
import { DATA_KEY } from '../test/backend/machines'
import { outsideThisTier } from '../test/backend/outside'
import { temporalOnPaper } from '../test/backend/projects'
import { pageSocketsOf, type PageSockets } from '../test/backend/sockets'
import { toolCallParsersOn } from '../test/backend/tool-calling'
import { shown } from '../test/backend/hooks'
import { deploymentsRouter } from '../../../backend/src/infrastructure/routes/deployments'
import { clustersRouter } from '../../../backend/src/infrastructure/routes/clusters'
import { identityRouter } from '../../../backend/src/instances/routes/identity'
import { AppService } from '../../../backend/src/infrastructure/services/AppService'
import { ClusterService } from '../../../backend/src/infrastructure/services/ClusterService'
import type { BuilderService } from '../../../backend/src/infrastructure/services/BuilderService'
import { TemporalBridge } from '../../../backend/src/infrastructure/services/TemporalBridge'
import { MachineClusters } from '../../../backend/src/machines/services/MachineClusters'
import { OdooReleaseService } from '../../../backend/src/releases/services/OdooReleaseService'
import type { InfrastructureService } from '../../../backend/src/infrastructure/services/InfrastructureService'
import type { AppExposureService } from '../../../backend/src/infrastructure/services/AppExposureService'
import type { ClusterProxyService } from '../../../backend/src/infrastructure/services/ClusterProxyService'
import type { GiteaService } from '../../../backend/src/projects/services/GiteaService'
import type { InfisicalService } from '../../../backend/src/infrastructure/services/InfisicalService'
import type { OdooReleaseDeps } from '../../../backend/src/releases/services/OdooReleaseService'
import { testClusterAccess } from '../../../backend/src/infrastructure/testing/cluster-access'
import { testDataDir } from '../../../backend/src/platform/testing/data-dir'
import { encryptValue } from '../../../backend/src/platform/lib/crypto'
import { roleFromEnv } from '../../../backend/src/platform/lib/platform-role'
import { generateIdentityKey } from '../../../backend/src/instances/lib/identity-token'
import type { DeploymentMetadata } from '../../../backend/src/platform/lib/types'

const temporal = temporalOnPaper()
let sockets: PageSockets | undefined
let bridge: TemporalBridge | undefined
let machines: MachineClusters | undefined
let releases: OdooReleaseService | undefined

const SHOP_PODS = { crashing: false }
const podsOf = (crashing: boolean) => JSON.stringify({ items: [{ metadata: { name: 'shop-0' }, status: { phase: 'Running', containerStatuses: [crashing ? { name: 'web', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } } : { name: 'web', ready: true, state: {} }] } }] })
const kubectl = async (args: readonly string[]): Promise<string> => {
  if (args.includes('namespaces')) return JSON.stringify({ items: [{ metadata: { name: 'shop-abcdef' } }] })
  if (args.includes('pods')) return podsOf(SHOP_PODS.crashing)
  throw new Error(`kubectl ${args.join(' ')} is not scripted here`)
}

const backend = await startBackend(async (site) => {
  const { api: router, db, io } = site
  const { parsers } = await toolCallParsersOn(site, {})
  const host = outsideThisTier<InfrastructureService>('the host\'s kubectl and helm', { getLogPath: (name: string) => `${testDataDir()}/${name}.log` })
  const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: DATA_KEY, answers: kubectl }))
  bridge = new TemporalBridge(db, testDataDir(), io, DATA_KEY, clusters, { connect: async () => temporal.client, toolCalling: parsers })
  await bridge.start()
  machines = new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: DATA_KEY, io })
  releases = new OdooReleaseService({
    store: db,
    decide: outsideThisTier<{ decide: OdooReleaseDeps['decide'] }>('the release decider').decide,
    runs: outsideThisTier<OdooReleaseDeps['runs']>('the release runs'),
    chartAt: outsideThisTier<{ chartAt: OdooReleaseDeps['chartAt'] }>('Gitea').chartAt,
    io,
  })
  router.use('/identity', identityRouter({ servesTenants: true }))
  router.use('/clusters', clustersRouter({
    clusterService: clusters,
    clusterProxyService: outsideThisTier<ClusterProxyService>('the cluster dashboard proxy'),
    giteaService: outsideThisTier<GiteaService>('Gitea'),
    infisicalService: outsideThisTier<InfisicalService>('Infisical'),
    access: clusters.access,
  }))
  router.use('/deployments', deploymentsRouter({
    appService: new AppService(db, host, clusters, outsideThisTier<BuilderService>('docker, which builds an app\'s modules into its image')),
    clusterService: clusters,
    appExposureService: outsideThisTier<AppExposureService>('app exposure, which writes the edge\'s routes'),
    temporalBridge: bridge,
    toolCalling: parsers,
    db,
    io,
  }))
  sockets = pageSocketsOf(site, roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: generateIdentityKey() }))
})

const owner = await backend.signIn()
await sockets!.open()
const { db } = backend
const app = (id: string, fields: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id, name: id, namespace: `${id}-abcdef`, clusterId: 'machine-desk', strategy: 'native', status: 'running', modules: [], storage: {}, ownerId: owner.id, deploymentId: `${id}-stack`, appType: 'hermes', ...fields })
await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: owner.id, machineId: 'desk', capacity: { cpuCores: 16, ramGb: 64 }, gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], gpuProblems: [] })
await db.infrastructure.saveCluster({ id: 'machine-rack', name: 'rack', provider: 'machine', status: 'healthy', ownerId: owner.id, machineId: 'rack', kubeconfigEnc: encryptValue('apiVersion: v1', DATA_KEY) })
await db.infrastructure.saveCluster({ id: 'machine-laptop', name: 'laptop', provider: 'machine', status: 'stopped', ownerId: owner.id, machineId: 'laptop' })
for (const seeded of [
  app('hermes'), app('books'), app('old'), app('side'), app('erp', { appType: 'odoo', webRepo: 'odoo', webTag: '18', dbRepo: 'postgres', dbTag: '16' }),
  app('shop', { clusterId: 'machine-rack' }), app('travels', { clusterId: 'machine-laptop' }),
  app('odoo-p1', { appType: 'odoo', status: 'deploying', gitappProjectId: 'p1' }),
]) await db.infrastructure.saveDeployment(seeded)
await bridge!.followWork()
await releases!.start()

const workOf = async (name: string): Promise<string> => {
  const found = (await db.infrastructure.getDeployments()).find((dep) => dep.name === name)?.temporalWorkflowId
  if (!found) throw new Error(`${name} names no workflow: ${JSON.stringify([...temporal.workflows.keys()])}`)
  return found
}
const rowOf = (name: string) => screen.queryAllByTestId('app-row').find((tr) => within(tr).queryByRole('link', { name })) ?? null
const badgeOf = (name: string, state: string) => { const row = rowOf(name); return row && within(row).queryByText(state) }

type Shows = { app: string; state: string; reason?: string; failure?: string } | { app: string; gone: true }

interface StatusChange {
  change: string
  act: () => Promise<unknown>
  shows: Shows
}

const changes: StatusChange[] = [
  { change: 'a deploy starts', act: () => deployApp(deployPayloadOf({ ...EMPTY_WIZARD_DATA, name: 'qwen', clusterId: 'machine-desk', appType: 'tabbyapi' })), shows: { app: 'qwen', state: 'deploying' } },
  { change: 'a deploy ends running', act: async () => temporal.complete(await workOf('qwen'), { workload: 'healthy' }), shows: { app: 'qwen', state: 'running' } },
  { change: 'a re-apply of its settings starts', act: () => patchDeploymentConfig('hermes', { storage: { data: '20Gi' } }), shows: { app: 'hermes', state: 'deploying' } },
  { change: 'a re-apply of its settings ends cancelled', act: async () => temporal.client.workflow.getHandle(await workOf('hermes')).cancel(), shows: { app: 'hermes', state: 'failed', failure: 'its workflow was cancelled' } },
  { change: 'a disk resize starts', act: () => api.patch('/deployments/books/storage', { storage: { data: '30Gi' } }), shows: { app: 'books', state: 'deploying' } },
  { change: 'a disk resize ends with the workload unhealthy', act: async () => temporal.complete(await workOf('books'), { workload: 'unhealthy', workloadReason: 'books-0: CrashLoopBackOff' }), shows: { app: 'books', state: 'unhealthy', reason: 'books-0: CrashLoopBackOff' } },
  { change: 'a destroy starts', act: () => destroyResource('old'), shows: { app: 'old', state: 'destroying' } },
  { change: 'a destroy ends', act: async () => temporal.complete(await workOf('old'), {}), shows: { app: 'old', gone: true } },
  { change: 'reconciliation finds its workload crashing', act: async () => { SHOP_PODS.crashing = true; await bridge!.checkApps() }, shows: { app: 'shop', state: 'unhealthy', reason: 'shop-0: CrashLoopBackOff' } },
  { change: 'reconciliation finds its workload well again', act: async () => { SHOP_PODS.crashing = false; await bridge!.checkApps() }, shows: { app: 'shop', state: 'running' } },
  { change: 'a module update cannot build its image', act: () => setDeploymentModules('erp', ['sale']), shows: { app: 'erp', state: 'failed' } },
  {
    change: 'another process starts removing it',
    act: async () => {
      await temporal.starter.start('executeDestroyAppWorkflow', { workflowId: 'destroy-side', taskQueue: 'cluster', args: [], memo: {} } as never)
      await db.infrastructure.saveDeploymentInfo({ id: 'side', status: 'destroying', temporalWorkflowId: 'destroy-side' })
    },
    shows: { app: 'side', state: 'destroying' },
  },
  { change: 'its machine is removed', act: () => machines!.forget({ id: 'laptop', ownerId: owner.id }), shows: { app: 'travels', gone: true } },
  {
    change: 'its project\'s release goes live',
    act: () => db.releases.saveOdooRelease({ id: 'r1', ownerId: owner.id, projectId: 'p1', pipelineRunId: 'run-1', commit: 'abc', image: 'reg/p1:abc', state: 'live', host: 'p1.koala.test', startedAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:05:00.000Z', toldAt: '2026-11-18T10:00:00.000Z' }),
    shows: { app: 'odoo-p1', state: 'running' },
  },
]

async function seen(shows: Shows): Promise<void> {
  if ('gone' in shows) {
    await shown(() => (rowOf(shows.app) ? null : rowOf('hermes')))
    expect(rowOf(shows.app)).toBeNull()
    return
  }
  const badge = await shown(() => badgeOf(shows.app, shows.state))
  expect(badge.textContent).toBe(shows.state)
  if (shows.reason !== undefined) expect(badge.getAttribute('title')).toBe(shows.reason)
  if (shows.failure !== undefined) expect(within(rowOf(shows.app)!).getByTestId('app-failure').textContent).toBe(shows.failure)
}

const openApps = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createProvisioningRouter(createMemoryHistory({ initialEntries: ['/infrastructure/apps'] }))
  render(<QueryClientProvider client={client}><App router={router} /></QueryClientProvider>)
  await shown(() => rowOf('hermes'))
}

describe('the apps a person has open follow every change to their status, told by the backend', () => {
  it.each(changes)('shows it as $change', async ({ act, shows }) => {
    await openApps()
    await act()
    await seen(shows)
  })
})
