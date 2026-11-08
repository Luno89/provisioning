import { Router, type RequestHandler } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { type Database, type MailService, type RoleConfig, servesTenants } from '../../platform/index.js';
import { runnersByRecord, type sharedClusterProxy, type ClusterService } from '../../infrastructure/index.js';
import type { ConversationNoticeService } from '../../engine/index.js';
import type { NotificationService } from '../services/NotificationService.js';
import type { PushService } from '../services/PushService.js';
import { AlertWatchService } from '../services/AlertWatchService.js';
import { MonitoringService, prometheusAt, type MonitoringDeps, type MonitoringSources } from '../services/MonitoringService.js';
import { alertNotice, alertWhere } from '../lib/alert-notices.js';
import { monitoringRouter } from '../routes/monitoring.js';
import { notificationsRouter } from '../routes/notifications.js';
import { poolMonitor, poolMonitorFrom } from '../services/PoolMonitor.js';
import type { Mounts } from '../../hub/index.js';

export interface MonitoringWiringDeps {
  machineStatus?: ((deviceId: string) => { online: boolean }) | undefined;
  tenant: Mounts;
  app: Mounts;
  operatorOnly: RequestHandler;
  db: Database;
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  io: Pick<SocketServer, 'to'>;
  clusters: MonitoredClusters;
  proxy: PrometheusProxy;
  notices: ConversationNoticeService;
  notifications: NotificationService;
  push: PushService;
  mail: MailService;
  people: ConstructorParameters<typeof AlertWatchService>[0]['people'];
  rootToken?: (() => Promise<string>) | undefined;
}

export type MonitoredClusters = Pick<ClusterService, 'getSystemClusterEntry' | 'access'>;
export type PrometheusProxy = Pick<ReturnType<typeof sharedClusterProxy>, 'serviceUrl'>;

export interface MonitoringServiceParts {
  db: MonitoringSources;
  clusters: MonitoredClusters;
  proxy: PrometheusProxy;
  pool?: ReturnType<typeof poolMonitor> | undefined;
  machineStatus?: ((deviceId: string) => { online: boolean }) | undefined;
  rootAlerts?: boolean | undefined;
}

export function monitoringDepsFor(parts: MonitoringServiceParts): MonitoringDeps {
  const { clusters, proxy } = parts;
  const { access } = clusters;
  return {
    store: parts.db,
    systemCluster: () => clusters.getSystemClusterEntry(),
    pool: (cluster) => (cluster.isSystem ? parts.pool : undefined),
    ...(parts.machineStatus ? { machineStatus: parts.machineStatus } : {}),
    prometheus: async (cluster) => prometheusAt(await proxy.serviceUrl(cluster.id, 'prometheus', await access.kubeconfigOf(cluster.id))),
    ...runnersByRecord(access),
    rootAlerts: parts.rootAlerts,
  };
}

export const monitoringServiceFor = (parts: MonitoringServiceParts): MonitoringService => new MonitoringService(monitoringDepsFor(parts));

export function wireMonitoring(deps: MonitoringWiringDeps): { monitoring: MonitoringService } {
  const { tenant, db, role, notices, notifications } = deps;
  const watchesItself = role.role === 'root';
  const placeOnPool = poolMonitorFrom(deps.env, deps.rootToken);
  const monitoring = monitoringServiceFor({
    db,
    clusters: deps.clusters,
    proxy: deps.proxy,
    pool: placeOnPool ? poolMonitor(placeOnPool) : undefined,
    machineStatus: deps.machineStatus,
    rootAlerts: watchesItself,
  });
  if (watchesItself) deps.app.use('/api/monitoring', Router().use(deps.operatorOnly, monitoringRouter({ monitoring })));
  else tenant.use('/api/monitoring', monitoringRouter({ monitoring }));
  (watchesItself ? deps.app : tenant).use('/api/notifications', notificationsRouter({ notifications, mail: deps.mail, push: deps.push }));
  if (servesTenants(role) || watchesItself) {
    new AlertWatchService({
      monitoring,
      store: db,
      people: deps.people,
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
