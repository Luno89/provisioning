import { describe, expect, expectTypeOf, it } from 'vitest'
import { getGpuStatus, listClusters } from './clusters'
import type { Cluster } from '../types/cluster'
import { startBackend } from '../../../test/backend/site'
import { infrastructureOf, type Infrastructure } from '../../../test/backend/infrastructure'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { clustersRouter } from '../../../../../backend/src/infrastructure/routes/clusters'
import type { ClusterProxyService } from '../../../../../backend/src/infrastructure/services/ClusterProxyService'
import type { GiteaService } from '../../../../../backend/src/projects/services/GiteaService'
import type { InfisicalService } from '../../../../../backend/src/infrastructure/services/InfisicalService'
import type { ClusterMetadata } from '../../../../../backend/src/platform/lib/types'
import { arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

let infra: Infrastructure | undefined

const backend = await startBackend(async (site) => {
  infra = await infrastructureOf(site)
  site.api.use('/clusters', clustersRouter({
    clusterService: infra.clusters,
    clusterProxyService: outsideThisTier<ClusterProxyService>('the cluster dashboard proxy'),
    giteaService: outsideThisTier<GiteaService>('Gitea'),
    infisicalService: outsideThisTier<InfisicalService>('Infisical'),
    access: infra.clusters.access,
  }))
})

const owner = await backend.signIn()
const MACHINE = { id: 'machine-desk', name: 'desk', provider: 'machine' as const, status: 'stopped' as const, ownerId: owner.id, machineId: 'desk' }
await backend.db.infrastructure.saveCluster(MACHINE)
await backend.db.infrastructure.saveCluster({ ...MACHINE, id: 'machine-theirs', name: 'theirs', machineId: 'theirs', ownerId: 'someone-else' })

expectTypeOf<Wire<ClusterMetadata>>().toExtend<Cluster>()

describe('clusters, as Infrastructure asks for them', () => {
  it('lists the person\'s own machine cluster and never another person\'s', async () => {
    const listed = await listClusters()
    expect(listed).toEqual(arrayWith([objectWith({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped' })]))
    expect(listed.map((cluster) => cluster.id)).not.toContain('machine-theirs')
  })

  it('reads no GPU status for a cluster the person cannot see, as null', async () => {
    expect(await getGpuStatus('machine-theirs')).toBeNull()
  })
})
