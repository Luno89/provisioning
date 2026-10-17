export const RANGES = ['1h', '24h', '7d', '30d'] as const;
export type Range = typeof RANGES[number];

export const RANGE_SECONDS: Record<Range, number> = { '1h': 3600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000 };

const POINTS = 240;

export function stepFor(range: Range): number {
  return Math.max(15, Math.round(RANGE_SECONDS[range] / POINTS));
}

export const isRange = (value: unknown): value is Range => typeof value === 'string' && (RANGES as readonly string[]).includes(value);

const label = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const regexValue = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface AppSubject {
  namespace: string;
  services?: string[] | undefined;
}

const BROKEN_REASONS = 'CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|CreateContainerError|InvalidImageName';
const REAL_FILESYSTEMS = 'ext4|xfs|btrfs|zfs';

const running = (ns: string) => `on(namespace, pod) group_left() (kube_pod_status_phase{namespace=${label(ns)},phase="Running"} == 1)`;

export function trafficSelector(app: AppSubject): string | undefined {
  if (!app.services?.length) return undefined;
  const names = app.services.map(regexValue).join('|');
  return `exported_service=~${label(`${regexValue(app.namespace)}-(${names})-[^@]+@kubernetes`)}`;
}

export const APP_QUESTIONS = ['probed', 'up', 'responseSeconds', 'podsRunning', 'podsBroken', 'memoryBytes', 'memoryLimitBytes', 'cpuCores', 'cpuLimitCores', 'volumeShare', 'requestsPerSecond', 'errorShare'] as const;
export type AppQuestion = typeof APP_QUESTIONS[number];

export function appQuery(question: AppQuestion, app: AppSubject): string | undefined {
  const ns = label(app.namespace);
  const traffic = trafficSelector(app);
  switch (question) {
    case 'probed': return `count(probe_success{namespace=${ns}})`;
    case 'up': return `max(probe_success{namespace=${ns}})`;
    case 'responseSeconds': return `avg(probe_duration_seconds{namespace=${ns}})`;
    case 'podsRunning': return `count(kube_pod_status_phase{namespace=${ns},phase="Running"} == 1)`;
    case 'podsBroken': return `count(kube_pod_container_status_waiting_reason{namespace=${ns},reason=~"${BROKEN_REASONS}"} == 1)`;
    case 'memoryBytes': return `sum(container_memory_working_set_bytes{namespace=${ns},container!="",container!="POD"})`;
    case 'memoryLimitBytes': return `sum(kube_pod_container_resource_limits{namespace=${ns},resource="memory"} * ${running(app.namespace)})`;
    case 'cpuCores': return `sum(rate(container_cpu_usage_seconds_total{namespace=${ns},container!="",container!="POD"}[5m]))`;
    case 'cpuLimitCores': return `sum(kube_pod_container_resource_limits{namespace=${ns},resource="cpu"} * ${running(app.namespace)})`;
    case 'volumeShare': return `max(kubelet_volume_stats_used_bytes{namespace=${ns}} / kubelet_volume_stats_capacity_bytes{namespace=${ns}})`;
    case 'requestsPerSecond': return traffic ? `sum(rate(traefik_service_requests_total{${traffic}}[5m]))` : undefined;
    case 'errorShare': return traffic ? `(sum(rate(traefik_service_requests_total{${traffic},code=~"5.."}[5m])) or vector(0)) / sum(rate(traefik_service_requests_total{${traffic}}[5m]))` : undefined;
  }
}

export function appWindowQuery(question: 'uptime' | 'restarts' | 'responseSeconds', app: AppSubject, seconds: number): string {
  const ns = label(app.namespace);
  const window = `${Math.max(60, Math.round(seconds))}s`;
  if (question === 'uptime') return `avg(avg_over_time(probe_success{namespace=${ns}}[${window}]))`;
  if (question === 'restarts') return `sum(increase(kube_pod_container_status_restarts_total{namespace=${ns}}[${window}]))`;
  return `avg(avg_over_time(probe_duration_seconds{namespace=${ns}}[${window}]))`;
}

export const CLUSTER_QUESTIONS = ['nodes', 'nodesNotReady', 'cpuShare', 'memoryShare', 'diskShare', 'podsPending', 'podsBroken'] as const;
export type ClusterQuestion = typeof CLUSTER_QUESTIONS[number];

export function clusterQuery(question: ClusterQuestion): string {
  switch (question) {
    case 'nodes': return 'count(kube_node_info)';
    case 'nodesNotReady': return 'count(kube_node_status_condition{condition="Ready",status="true"} == 0)';
    case 'cpuShare': return '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))';
    case 'memoryShare': return '1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)';
    case 'diskShare': return `max(1 - node_filesystem_avail_bytes{fstype=~"${REAL_FILESYSTEMS}"} / node_filesystem_size_bytes{fstype=~"${REAL_FILESYSTEMS}"})`;
    case 'podsPending': return 'count(kube_pod_status_phase{phase=~"Pending|Failed|Unknown"} == 1)';
    case 'podsBroken': return `count(kube_pod_container_status_waiting_reason{reason=~"${BROKEN_REASONS}"} == 1)`;
  }
}

export const APP_CHARTS = ['up', 'responseSeconds', 'memoryShare', 'cpuShare', 'requestsPerSecond', 'errorShare'] as const;
export type AppChart = typeof APP_CHARTS[number];

export function appChartQuery(chart: AppChart, app: AppSubject): string | undefined {
  if (chart === 'memoryShare') return `(${appQuery('memoryBytes', app)}) / (${appQuery('memoryLimitBytes', app)})`;
  if (chart === 'cpuShare') return `(${appQuery('cpuCores', app)}) / (${appQuery('cpuLimitCores', app)})`;
  return appQuery(chart, app);
}

export const CLUSTER_CHARTS = ['cpuShare', 'memoryShare', 'diskShare'] as const;
export type ClusterChart = typeof CLUSTER_CHARTS[number];

export const clusterChartQuery = (chart: ClusterChart): string => clusterQuery(chart);
