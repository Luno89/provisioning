import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory } from '@tanstack/react-router'
import App from '../App'
import { createProvisioningRouter } from './router'
import { patchDeploymentConfig } from '../features/infrastructure/api/deployments'
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
import { BuilderService } from '../../../backend/src/infrastructure/services/BuilderService'
import { TemporalBridge } from '../../../backend/src/infrastructure/services/TemporalBridge'
import type { InfrastructureService } from '../../../backend/src/infrastructure/services/InfrastructureService'
import type { AppExposureService } from '../../../backend/src/infrastructure/services/AppExposureService'
import type { ClusterProxyService } from '../../../backend/src/infrastructure/services/ClusterProxyService'
import type { GiteaService } from '../../../backend/src/projects/services/GiteaService'
import type { InfisicalService } from '../../../backend/src/infrastructure/services/InfisicalService'
import { testClusterAccess } from '../../../backend/src/infrastructure/testing/cluster-access'
import { testDataDir } from '../../../backend/src/platform/testing/data-dir'
import { roleFromEnv } from '../../../backend/src/platform/lib/platform-role'
import { generateIdentityKey } from '../../../backend/src/instances/lib/identity-token'

const temporal = temporalOnPaper()
let sockets: PageSockets | undefined

const backend = await startBackend(async (site) => {
  const { api, db, io } = site
  const { parsers } = await toolCallParsersOn(site, {})
  const host = outsideThisTier<InfrastructureService>('the host\'s kubectl and helm')
  const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: DATA_KEY }))
  const bridge = new TemporalBridge(db, testDataDir(), io, DATA_KEY, clusters, { connect: async () => temporal.client, toolCalling: parsers })
  await bridge.start()
  api.use('/identity', identityRouter({ servesTenants: true }))
  api.use('/clusters', clustersRouter({
    clusterService: clusters,
    clusterProxyService: outsideThisTier<ClusterProxyService>('the cluster dashboard proxy'),
    giteaService: outsideThisTier<GiteaService>('Gitea'),
    infisicalService: outsideThisTier<InfisicalService>('Infisical'),
    access: clusters.access,
  }))
  api.use('/deployments', deploymentsRouter({
    appService: new AppService(db, host, clusters, new BuilderService(db, host)),
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
await backend.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: owner.id, machineId: 'desk' })
await backend.db.infrastructure.saveDeployment({ id: 'hermes', name: 'hermes', namespace: 'hermes-abcdef', clusterId: 'machine-desk', strategy: 'native', status: 'running', modules: [], storage: {}, ownerId: owner.id, deploymentId: 'hermes-stack', appType: 'hermes' })

const openApps = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createProvisioningRouter(createMemoryHistory({ initialEntries: ['/infrastructure/apps'] }))
  return render(<QueryClientProvider client={client}><App router={router} /></QueryClientProvider>)
}

describe('the apps a person has open follow what their work ends as', () => {
  afterEach(() => { vi.useRealTimers() })

  it('shows an app whose settings were being re-applied as failed, with why, as its work ends, told by the backend while the page\'s own refresh stands still', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    openApps()
    const row = await shown(() => screen.queryAllByTestId('app-row').find((tr) => within(tr).queryByRole('link', { name: 'hermes' })) ?? null)
    expect(within(row).getByText('running')).toBeTruthy()
    await patchDeploymentConfig('hermes', { storage: { data: '20Gi' } })
    const syncing = [...temporal.workflows.values()].find((run) => run.workflowType === 'executeSyncConfigWorkflow')
    if (!syncing) throw new Error(`no re-apply was started: ${JSON.stringify([...temporal.workflows.keys()])}`)
    const failed = shown(() => within(row).queryByTestId('app-failure'))
    await temporal.client.workflow.getHandle(syncing.workflowId).cancel()
    expect((await failed).textContent).toBe('its workflow was cancelled')
    expect(within(row).getByText('failed')).toBeTruthy()
  })
})
