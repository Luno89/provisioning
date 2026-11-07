import { describe, expect, expectTypeOf, it } from 'vitest'
import { type ClusterCreated, destroyCluster, getGpuStatus, listClusters, provisionCluster } from './clusters'
import { type ClusterProviderSpec, listClusterProviders } from './cluster-providers'
import type { Cluster } from '../types/cluster'
import { startBackend } from '../../../test/backend/site'
import { infrastructureOf, type Infrastructure } from '../../../test/backend/infrastructure'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { clustersRouter, type ProvisionStarted } from '../../../../../backend/src/infrastructure/routes/clusters'
import { clusterProvidersRouter } from '../../../../../backend/src/infrastructure/routes/cluster-providers'
import type { ClusterProxyService } from '../../../../../backend/src/infrastructure/services/ClusterProxyService'
import type { GiteaService } from '../../../../../backend/src/projects/services/GiteaService'
import type { InfisicalService } from '../../../../../backend/src/infrastructure/services/InfisicalService'
import type { ClusterMetadata } from '../../../../../backend/src/platform/lib/types'
import type { offeredProviders } from '../../../../../backend/src/infrastructure/lib/cluster-providers'
import { anyOf, arrayWith, containing, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

let infra: Infrastructure | undefined

const backend = await startBackend(async (site) => {
  infra = await infrastructureOf(site)
  site.api.use('/clusters', clustersRouter({
    clusterService: infra.clusters,
    clusterProxyService: outsideThisTier<ClusterProxyService>('the cluster dashboard proxy', { stopForCluster: () => undefined }),
    giteaService: outsideThisTier<GiteaService>('Gitea'),
    infisicalService: outsideThisTier<InfisicalService>('Infisical'),
    infraService: infra.host,
    temporalBridge: infra.bridge,
    io: infra.io,
  }))
  site.api.use('/cluster-providers', clusterProvidersRouter({ db: site.db }))
})

const owner = await backend.signIn()
const MACHINE = { id: 'machine-desk', name: 'desk', provider: 'machine' as const, status: 'stopped' as const, ownerId: owner.id, machineId: 'desk' }
await backend.db.infrastructure.saveCluster(MACHINE)
await backend.db.infrastructure.saveCluster({ ...MACHINE, id: 'machine-theirs', name: 'theirs', machineId: 'theirs', ownerId: 'someone-else' })

expectTypeOf<Wire<ClusterMetadata>>().toExtend<Cluster>()
expectTypeOf<Wire<ProvisionStarted>>().toExtend<ClusterCreated>()
expectTypeOf<Wire<ReturnType<typeof offeredProviders>[number]>>().toExtend<ClusterProviderSpec>()

describe('clusters, as Infrastructure and Provision a cluster ask for them', () => {
  it('offers only the providers Koala makes clusters on, never a joined machine or one not built', async () => {
    const providers = await listClusterProviders()
    expect(providers.map((provider) => provider.value)).toEqual(['k3d', 'hetzner', 'do'])
    expect(providers.every((provider) => typeof provider.label === 'string' && typeof provider.hasCatalog === 'boolean')).toBe(true)
  })

  it('lists the person\'s own machine cluster and never another person\'s', async () => {
    const listed = await listClusters()
    expect(listed).toEqual(arrayWith([objectWith({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped' })]))
    expect(listed.map((cluster) => cluster.id)).not.toContain('machine-theirs')
  })

  it('starts provisioning a k3d cluster and answers with its id', async () => {
    const made = await provisionCluster({ name: 'scratch', provider: 'k3d' })
    expect(made).toEqual({ message: 'Provisioning started', clusterName: 'scratch', provider: 'k3d', id: anyOf(String), workflowId: anyOf(String), state: 'running' })
    expect(infra!.temporal.started.at(-1)?.options.workflowId).toBe(made.workflowId)
  })

  it('refuses a name a cluster cannot have, with a suggestion', async () => {
    await expect(provisionCluster({ name: 'Not A Name!', provider: 'k3d' })).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })

  it('refuses a provider Koala does not make clusters on, and a machine, which is joined rather than made', async () => {
    await expect(provisionCluster({ name: 'cloudy', provider: 'nowhere' })).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
    await expect(provisionCluster({ name: 'joined', provider: 'machine' })).rejects.toMatchObject({ response: { status: 400, data: { error: containing('My Machines') } } })
  })

  it('answers 404 when destroying a cluster that is someone else\'s or does not exist', async () => {
    await expect(destroyCluster('machine-theirs')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Cluster not found' } } })
    await expect(destroyCluster('nowhere')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Cluster not found' } } })
  })

  it('reads no GPU status for a cluster the person cannot see, as null', async () => {
    expect(await getGpuStatus('machine-theirs')).toBeNull()
  })
})
