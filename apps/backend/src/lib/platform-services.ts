import type { Workload, WorkloadState } from './cluster-workloads.js';

export interface HelmReleaseJson {
  name: string;
  namespace: string;
  status: string;
  chart: string;
  app_version?: string | undefined;
  updated?: string | undefined;
}

export type ServiceKey = 'prometheus' | 'grafana' | 'alertmanager' | 'traefik' | 'gitea' | 'loki' | 'infisical';

interface ServiceShape {
  key: ServiceKey;
  label: string;
  does: string;
  namespace: string;
  releases: readonly string[];
  workloads: readonly string[];
  dashboard: boolean;
  access: string;
}

export const PLATFORM_SERVICES: readonly ServiceShape[] = [
  { key: 'prometheus', label: 'Prometheus', does: 'collects the measurements Infrastructure shows', namespace: 'monitoring', releases: ['kube-prometheus-stack'], workloads: ['prometheus-kube-prometheus-stack-prometheus', 'kube-prometheus-stack-operator', 'kube-prometheus-stack-kube-state-metrics', 'kube-prometheus-stack-prometheus-node-exporter', 'blackbox-exporter'], dashboard: true, access: 'No sign-in: anyone who can reach it can read it.' },
  { key: 'grafana', label: 'Grafana', does: 'dashboards over the same measurements', namespace: 'monitoring', releases: ['kube-prometheus-stack'], workloads: ['kube-prometheus-stack-grafana'], dashboard: true, access: 'Opens signed in as admin.' },
  { key: 'alertmanager', label: 'Alertmanager', does: 'holds the alerts Prometheus raises', namespace: 'monitoring', releases: ['kube-prometheus-stack'], workloads: ['alertmanager-kube-prometheus-stack-alertmanager'], dashboard: true, access: 'No sign-in: anyone who can reach it can read it.' },
  { key: 'traefik', label: 'Traefik', does: 'routes requests to the apps', namespace: 'traefik', releases: ['traefik'], workloads: ['traefik'], dashboard: true, access: 'No sign-in: its dashboard runs unauthenticated.' },
  { key: 'gitea', label: 'Gitea', does: 'keeps every project\'s repository and builds', namespace: 'gitea', releases: ['gitea'], workloads: ['gitea', 'gitea-postgresql'], dashboard: true, access: 'Opens signed in as provisioning-bot.' },
  { key: 'loki', label: 'Loki', does: 'keeps the apps\' logs', namespace: 'monitoring', releases: ['loki', 'promtail'], workloads: ['loki', 'loki-gateway', 'promtail', 'loki-canary', 'loki-chunks-cache', 'loki-results-cache', 'loki-minio'], dashboard: false, access: 'No dashboard of its own; read its logs in Grafana.' },
  { key: 'infisical', label: 'Infisical', does: 'keeps the apps\' secrets', namespace: 'infisical', releases: ['infisical-standalone', 'infisical'], workloads: ['infisical-infisical-standalone-infisical', 'infisical-opera-controller-manager', 'postgresql', 'redis-master', 'infisical-ingress-nginx-controller'], dashboard: true, access: 'Opens signed in as admin.' },
];

export interface PlatformService {
  key: ServiceKey;
  label: string;
  does: string;
  installed: boolean;
  release?: { name: string; chart: string; version?: string | undefined; status: string } | undefined;
  state: WorkloadState | 'absent';
  reasons: string[];
  pods: { total: number; ready: number };
  dashboard: boolean;
  access: string;
}

const RANK: Record<WorkloadState, number> = { down: 3, warning: 2, starting: 1, ok: 0 };

export function platformServices(workloads: readonly Workload[], releases: readonly HelmReleaseJson[]): PlatformService[] {
  return PLATFORM_SERVICES.map((shape) => {
    const release = releases.find((entry) => shape.releases.includes(entry.name));
    const mine = workloads.filter((workload) => workload.namespace === shape.namespace && shape.workloads.includes(workload.name));
    const installed = Boolean(release) || mine.length > 0;
    let state: PlatformService['state'] = installed ? 'ok' : 'absent';
    const reasons: string[] = [];
    for (const workload of mine) {
      if (state === 'absent' || RANK[workload.state] > RANK[state]) state = workload.state;
      for (const reason of workload.reasons) reasons.push(`${workload.name}: ${reason}`);
    }
    if (release && release.status !== 'deployed') {
      if (state === 'ok' || state === 'starting' || state === 'absent') state = 'warning';
      reasons.unshift(`its Helm release is ${release.status}`);
    }
    return {
      key: shape.key,
      label: shape.label,
      does: shape.does,
      installed,
      ...(release ? { release: { name: release.name, chart: release.chart, ...(release.app_version ? { version: release.app_version } : {}), status: release.status } } : {}),
      state,
      reasons,
      pods: mine.reduce((sum, workload) => ({ total: sum.total + workload.pods.total, ready: sum.ready + workload.pods.ready }), { total: 0, ready: 0 }),
      dashboard: shape.dashboard && installed,
      access: shape.access,
    };
  });
}
