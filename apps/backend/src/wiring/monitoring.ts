import type { Server as SocketServer } from 'socket.io';
import type { Database } from '../lib/db-interface.js';
import type { sharedClusterProxy } from '../services/ClusterProxyService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { ConversationNoticeService } from '../services/ConversationNoticeService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { MailService } from '../services/MailService.js';
import type { NotificationService } from '../services/NotificationService.js';
import type { RoleConfig } from '../lib/platform-role.js';
import { AlertWatchService } from '../services/AlertWatchService.js';
import { MonitoringService, prometheusAt } from '../services/MonitoringService.js';
import { alertNotice, alertWhere } from '../lib/alert-notices.js';
import { monitoringRouter } from '../routes/monitoring.js';
import { notificationsRouter } from '../routes/notifications.js';
import { poolMonitor, poolMonitorFrom } from '../services/PoolMonitor.js';
import { servesTenants } from '../lib/platform-role.js';
import type { Mounts } from './hub.js';

export interface MonitoringWiringDeps {
  tenant: Mounts;
  db: Database;
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  io: Pick<SocketServer, 'to'>;
  clusters: ClusterService;
  infra: InfrastructureService;
  proxy: ReturnType<typeof sharedClusterProxy>;
  notices: ConversationNoticeService;
  notifications: NotificationService;
  mail: MailService;
  systemOwners: ConstructorParameters<typeof AlertWatchService>[0]['systemOwners'];
}

export function wireMonitoring(deps: MonitoringWiringDeps): { monitoring: MonitoringService } {
  const { tenant, db, role, clusters, infra, notices, notifications } = deps;
  const placeOnPool = poolMonitorFrom(deps.env);
  const onPool = placeOnPool ? poolMonitor(placeOnPool) : undefined;
  const monitoring = new MonitoringService({
    store: db,
    systemCluster: () => clusters.getSystemClusterEntry(),
    ownsSystem: (viewer) => (role.instance ? viewer.id === role.instance.ownerId : Boolean(viewer.isAdmin)),
    pool: (cluster) => (cluster.isSystem ? onPool : undefined),
    prometheus: async (cluster) => prometheusAt(await deps.proxy.serviceUrl(cluster.id, 'prometheus', await clusters.getKubeconfigPath(cluster))),
    kubectl: async (cluster, args) => String(await infra.runKubectl(args, await clusters.getKubeconfigPath(cluster))),
    apply: async (cluster, manifest) => { await infra.applyManifest(manifest, await clusters.getKubeconfigPath(cluster)); },
    helm: async (cluster, args) => String(await infra.runHelm(args, await clusters.getKubeconfigPath(cluster))),
  });
  tenant.use('/api/monitoring', monitoringRouter({ monitoring }));
  tenant.use('/api/notifications', notificationsRouter({ notifications, mail: deps.mail }));
  if (servesTenants(role)) {
    new AlertWatchService({
      monitoring,
      store: db,
      systemOwners: deps.systemOwners,
      tell: async (episode, change, { app, rule }) => {
        deps.io.to(`user:${episode.ownerId}`).emit('monitoring-alert', { change, episode });
        const where = alertWhere(app?.gitappProjectId, rule?.conversationId);
        const notice = alertNotice(episode, change);
        if (where.projectId) await notices.post(episode.ownerId, { projectId: where.projectId }, { ...notice, refs: { ...notice.refs, projectId: where.projectId } });
        else if (where.conversationId) await notices.postTo(episode.ownerId, where.conversationId, notice);
        await notifications.alert(episode, change).catch((err: Error) => console.warn(`[alerts] could not email ${episode.ownerId}: ${err.message}`));
      },
      log: (message) => console.warn(message),
    }).start();
  }
  return { monitoring };
}
