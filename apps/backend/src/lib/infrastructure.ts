import { APP_FACTS, type AppType } from './app-catalog.js';
import { clusterAuthority } from './cluster-dns.js';
import { bindingTypeFor } from './service-binding.js';

export interface RunningService {
  name: string;
  type: string;
  is?: string;
  provides?: string[];
  namespace: string;
  address?: string;
  bindingType?: string;
}

export interface Infrastructure {
  running: RunningService[];
  broken: { name: string; type: string; reason: string }[];
  deployable: { id: string; is: string; provides: string[] }[];
}

interface DeploymentLike {
  name: string;
  appType?: string | undefined;
  status?: string | undefined;
  ownerId?: string | undefined;
  healthReason?: string | undefined;
}

export const CLUSTER_PLATFORM_SERVICES: readonly RunningService[] = [
  {
    name: 'prometheus',
    type: 'prometheus',
    is: 'cluster metrics database and alerting engine',
    provides: ['PromQL query endpoint and telemetry metrics'],
    namespace: 'monitoring',
    address: 'http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090',
  },
  {
    name: 'grafana',
    type: 'grafana',
    is: 'cluster metrics and logs visualization dashboard',
    provides: ['Grafana UI and visual observability dashboards'],
    namespace: 'monitoring',
    address: 'http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local:80',
  },
  {
    name: 'loki',
    type: 'loki',
    is: 'log aggregation engine',
    provides: ['LogQL query endpoint for cluster and container logs'],
    namespace: 'monitoring',
    address: 'http://loki.monitoring.svc.cluster.local:3100',
  },
  {
    name: 'alertmanager',
    type: 'alertmanager',
    is: 'cluster alert routing and notification manager',
    provides: ['Alert dispatch and webhook notifications'],
    namespace: 'monitoring',
    address: 'http://alertmanager-kube-prometheus-stack-alertmanager.monitoring.svc.cluster.local:9093',
  },
  {
    name: 'gitea',
    type: 'gitea',
    is: 'self-hosted git server and container registry',
    provides: ['Git repositories, code hosting, and container registry'],
    namespace: 'gitea',
    address: 'http://gitea-http.gitea.svc.cluster.local:3000',
  },
  {
    name: 'infisical',
    type: 'infisical',
    is: 'secret and token management vault (AES-256-GCM encrypted, Kubernetes operator synced)',
    provides: ['Secret vault, API tokens, credentials management, pod secret injection'],
    namespace: 'infisical',
    address: 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080',
  },
];

interface CatalogueSpecLike {
  id: string;
  spec: { ports?: { port: number }[] };
  label?: string | undefined;
  is?: string | undefined;
  provides?: string[] | undefined;
}

export function describeInfrastructure(
  deployments: readonly DeploymentLike[],
  ownerId: string,
  specs: readonly CatalogueSpecLike[] = [],
  options?: { isAdmin?: boolean | undefined; isEscalated?: boolean | undefined } | undefined,
): Infrastructure {
  const byType = new Map(specs.map((s) => [s.id, s.spec]));
  const userServices = deployments
    .filter((d) => d.ownerId === ownerId && d.status === 'running')
    .map((d) => ({
      name: d.name,
      type: d.appType ?? 'unknown',
      ...(d.appType && d.appType in APP_FACTS
        ? {
            is: APP_FACTS[d.appType as AppType].is,
            provides: APP_FACTS[d.appType as AppType].provides,
          }
        : {}),
      namespace: String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      ...addressOf(d, byType),
    }));

  const platformServices = options?.isAdmin || options?.isEscalated ? CLUSTER_PLATFORM_SERVICES : [];

  return {
    running: [...userServices, ...platformServices],
    broken: deployments
      .filter((d) => d.ownerId === ownerId && (d.status === 'unhealthy' || d.status === 'failed'))
      .map((d) => ({
        name: d.name,
        type: d.appType ?? 'unknown',
        reason: d.healthReason?.trim() || `status is ${d.status}`,
      })),
    // Sourced from the same catalogue the deploy wizard reads (visibleAppSpecs) — not the static
    // APP_TYPES/APP_FACTS table, which only ever described apps, never proved they were deployable.
    deployable: specs.map((s) => ({
      id: s.id,
      is: s.is ?? 'a custom application',
      provides: s.provides ?? [],
    })),
  };
}

export function findCapability(
  want: string,
  infra: Infrastructure,
): { running?: RunningService; deployable: boolean } {
  const needle = want.trim().toLowerCase();
  const running = infra.running.find(
    (s) => s.type.toLowerCase() === needle || s.name.toLowerCase().includes(needle),
  );
  return {
    ...(running ? { running } : {}),
    deployable: infra.deployable.some((t) => t.id.toLowerCase() === needle
      || t.provides.some((p) => p === needle)),
  };
}

function addressOf(
  d: DeploymentLike,
  byType: Map<string, { ports?: { port: number }[] }>,
): { address?: string; bindingType?: string } {
  const spec = d.appType ? byType.get(d.appType) : undefined;
  const port = spec?.ports?.[0]?.port;
  if (!spec || port === undefined) return {};
  const namespace = String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return {
    address: clusterAuthority({ service: String(d.appType), namespace, port }),
    ...(bindingTypeFor(String(d.appType)) ? { bindingType: bindingTypeFor(String(d.appType))! } : {}),
  };
}
