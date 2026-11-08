import { Server } from 'socket.io'
import type { Site } from './site'
import { DATA_KEY } from './machines'
import { outsideThisTier, recordedTemporal, type RecordedTemporal } from './outside'
import { AppService } from '../../../../backend/src/infrastructure/services/AppService'
import { ClusterService } from '../../../../backend/src/infrastructure/services/ClusterService'
import { BuilderService } from '../../../../backend/src/infrastructure/services/BuilderService'
import { TemporalBridge } from '../../../../backend/src/infrastructure/services/TemporalBridge'
import type { InfrastructureService } from '../../../../backend/src/infrastructure/services/InfrastructureService'
import { MonitoringService } from '../../../../backend/src/monitoring/services/MonitoringService'
import { testClusterAccess } from '../../../../backend/src/infrastructure/testing/cluster-access'

export interface Infrastructure {
  host: InfrastructureService
  clusters: ClusterService
  apps: AppService
  bridge: TemporalBridge
  temporal: RecordedTemporal
  monitoring: MonitoringService
  io: Server
}

export async function infrastructureOf({ db }: Site, koalaMachineId?: string, instanceOwnerId?: string): Promise<Infrastructure> {
  const host = outsideThisTier<InfrastructureService>('the host\'s kubectl and helm')
  const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: DATA_KEY, koalaMachineId }), { instanceOwnerId })
  const apps = new AppService(db, host, clusters, new BuilderService(db, host))
  const temporal = recordedTemporal()
  const bridge = new TemporalBridge(db, undefined, DATA_KEY, clusters, undefined, { connect: async () => temporal.client })
  await bridge.start()
  const reach = (what: string) => async (): Promise<never> => { throw new Error(`${what} reaches a cluster, which the integration tier never does`) }
  const monitoring = new MonitoringService({
    store: db,
    ownCluster: () => clusters.ownCluster(),
    ownClusterId: () => clusters.ownClusterId(),
    prometheus: reach('Prometheus'),
    kubectl: reach('kubectl'),
    apply: reach('kubectl apply'),
    helm: reach('helm'),
    rootAlerts: false,
  })
  return { host, clusters, apps, bridge, temporal, monitoring, io: new Server() }
}
