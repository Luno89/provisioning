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

export interface PoolPlace {
  hostNamespace: string;
}

export const VIRTUAL_NAMESPACE_LABEL = 'label_vcluster_loft_sh_namespace';
export const VIRTUAL_NAME_ANNOTATION = 'annotation_vcluster_loft_sh_object_name';
export const PROBE_NAMESPACE_LABEL = 'koala_namespace';

const hostOf = (app: AppSubject, place: PoolPlace | undefined) => label(place ? place.hostNamespace : app.namespace);

const podsOf = (app: AppSubject, place: PoolPlace) =>
  `max by (namespace, pod) (kube_pod_labels{namespace=${label(place.hostNamespace)},${VIRTUAL_NAMESPACE_LABEL}=${label(app.namespace)}})`;

const claimsOf = (app: AppSubject, place: PoolPlace) =>
  `max by (namespace, persistentvolumeclaim) (kube_persistentvolumeclaim_labels{namespace=${label(place.hostNamespace)},${VIRTUAL_NAMESPACE_LABEL}=${label(app.namespace)}})`;

const ofPods = (metric: string, matchers: string, app: AppSubject, place: PoolPlace | undefined) => {
  const selected = `${metric}{namespace=${hostOf(app, place)}${matchers}}`;
  return place ? `(${selected} * on(namespace, pod) group_left() ${podsOf(app, place)})` : selected;
};

const ofClaims = (metric: string, app: AppSubject, place: PoolPlace | undefined) => {
  const selected = `${metric}{namespace=${hostOf(app, place)}}`;
  return place ? `(${selected} * on(namespace, persistentvolumeclaim) group_left() ${claimsOf(app, place)})` : selected;
};

const ofProbes = (metric: string, app: AppSubject, place: PoolPlace | undefined) =>
  place ? `${metric}{namespace=${label(place.hostNamespace)},${PROBE_NAMESPACE_LABEL}=${label(app.namespace)}}` : `${metric}{namespace=${label(app.namespace)}}`;

const podLevel = (metric: string, place: PoolPlace) => `max by (namespace, pod) (${metric}{namespace=${label(place.hostNamespace)},container=""})`;
const podLevelRate = (metric: string, place: PoolPlace) => `max by (namespace, pod) (rate(${metric}{namespace=${label(place.hostNamespace)},container=""}[5m]))`;

const running = (app: AppSubject, place: PoolPlace | undefined) =>
  `on(namespace, pod) group_left() (kube_pod_status_phase{namespace=${hostOf(app, place)},phase="Running"} == 1)`;

export function trafficSelector(app: AppSubject): string | undefined {
  if (!app.services?.length) return undefined;
  const names = app.services.map(regexValue).join('|');
  return `exported_service=~${label(`${regexValue(app.namespace)}-(${names})-[^@]+@kubernetes`)}`;
}

export const APP_QUESTIONS = ['probed', 'up', 'responseSeconds', 'podsRunning', 'podsBroken', 'memoryBytes', 'memoryLimitBytes', 'cpuCores', 'cpuLimitCores', 'volumeShare', 'requestsPerSecond', 'errorShare'] as const;
export type AppQuestion = typeof APP_QUESTIONS[number];

export function appQuery(question: AppQuestion, app: AppSubject, place?: PoolPlace): string | undefined {
  const traffic = place ? undefined : trafficSelector(app);
  switch (question) {
    case 'probed': return `count(${ofProbes('probe_success', app, place)})`;
    case 'up': return `max(${ofProbes('probe_success', app, place)})`;
    case 'responseSeconds': return `avg(${ofProbes('probe_duration_seconds', app, place)})`;
    case 'podsRunning': return `count(${ofPods('kube_pod_status_phase', ',phase="Running"', app, place)} == 1)`;
    case 'podsBroken': return `count(${ofPods('kube_pod_container_status_waiting_reason', `,reason=~"${BROKEN_REASONS}"`, app, place)} == 1)`;
    case 'memoryBytes': return place
      ? `sum(${podLevel('container_memory_working_set_bytes', place)} * on(namespace, pod) group_left() ${podsOf(app, place)})`
      : `sum(${ofPods('container_memory_working_set_bytes', ',container!="",container!="POD"', app, place)})`;
    case 'memoryLimitBytes': return `sum(${ofPods('kube_pod_container_resource_limits', ',resource="memory"', app, place)} * ${running(app, place)})`;
    case 'cpuCores': return place
      ? `sum(${podLevelRate('container_cpu_usage_seconds_total', place)} * on(namespace, pod) group_left() ${podsOf(app, place)})`
      : `sum(rate(container_cpu_usage_seconds_total{namespace=${hostOf(app, place)},container!="",container!="POD"}[5m]))`;
    case 'cpuLimitCores': return `sum(${ofPods('kube_pod_container_resource_limits', ',resource="cpu"', app, place)} * ${running(app, place)})`;
    case 'volumeShare': return `max(${ofClaims('kubelet_volume_stats_used_bytes', app, place)} / ${ofClaims('kubelet_volume_stats_capacity_bytes', app, place)})`;
    case 'requestsPerSecond': return traffic ? `sum(rate(traefik_service_requests_total{${traffic}}[5m]))` : undefined;
    case 'errorShare': return traffic ? `(sum(rate(traefik_service_requests_total{${traffic},code=~"5.."}[5m])) or vector(0)) / sum(rate(traefik_service_requests_total{${traffic}}[5m]))` : undefined;
  }
}

export const WINDOW_QUESTIONS = ['uptime', 'restarts', 'responseSeconds'] as const;
export type WindowQuestion = typeof WINDOW_QUESTIONS[number];

export function appWindowQuery(question: WindowQuestion, app: AppSubject, seconds: number, place?: PoolPlace): string {
  const window = `${Math.max(60, Math.round(seconds))}s`;
  if (question === 'uptime') return `avg(avg_over_time(${ofProbes('probe_success', app, place)}[${window}]))`;
  if (question === 'restarts') {
    const restarts = `increase(kube_pod_container_status_restarts_total{namespace=${hostOf(app, place)}}[${window}])`;
    return place ? `sum(${restarts} * on(namespace, pod) group_left() ${podsOf(app, place)})` : `sum(${restarts})`;
  }
  return `avg(avg_over_time(${ofProbes('probe_duration_seconds', app, place)}[${window}]))`;
}

export const CLUSTER_QUESTIONS = ['nodes', 'nodesNotReady', 'cpuShare', 'memoryShare', 'diskShare', 'podsPending', 'podsBroken'] as const;
export type ClusterQuestion = typeof CLUSTER_QUESTIONS[number];

const quota = (place: PoolPlace, resource: string) =>
  `sum(kube_resourcequota{namespace=${label(place.hostNamespace)},resource="${resource}",type="hard"})`;

function placeQuery(question: ClusterQuestion, place: PoolPlace): string {
  const ns = label(place.hostNamespace);
  switch (question) {
    case 'nodes': return 'count(kube_node_info)';
    case 'nodesNotReady': return 'count(kube_node_status_condition{condition="Ready",status="true"} == 0)';
    case 'cpuShare': return `sum(${podLevelRate('container_cpu_usage_seconds_total', place)}) / ${quota(place, 'requests.cpu')}`;
    case 'memoryShare': return `sum(${podLevel('container_memory_working_set_bytes', place)}) / ${quota(place, 'requests.memory')}`;
    case 'diskShare': return `sum(kube_persistentvolumeclaim_resource_requests_storage_bytes{namespace=${ns}}) / ${quota(place, 'requests.storage')}`;
    case 'podsPending': return `count(kube_pod_status_phase{namespace=${ns},phase=~"Pending|Failed|Unknown"} == 1)`;
    case 'podsBroken': return `count(kube_pod_container_status_waiting_reason{namespace=${ns},reason=~"${BROKEN_REASONS}"} == 1)`;
  }
}

export function clusterQuery(question: ClusterQuestion, place?: PoolPlace): string {
  if (place) return placeQuery(question, place);
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

export const USAGES = ['memory', 'cpu'] as const;
export type Usage = typeof USAGES[number];

const USAGE_METRIC: Record<Usage, string> = {
  memory: 'container_memory_working_set_bytes{container!="",image!=""%s}',
  cpu: 'rate(container_cpu_usage_seconds_total{container!="",image!=""%s}[5m])',
};

export function usageQuery(of: Usage, place?: PoolPlace): string {
  if (!place) return `sum by (namespace, pod) (${USAGE_METRIC[of].replace('%s', '')})`;
  const ns = label(place.hostNamespace);
  const named = `max by (namespace, pod, ${VIRTUAL_NAMESPACE_LABEL}, ${VIRTUAL_NAME_ANNOTATION}) (kube_pod_labels{namespace=${ns}} * on(namespace, pod) group_left(${VIRTUAL_NAME_ANNOTATION}) kube_pod_annotations{namespace=${ns}})`;
  const perPod = of === 'memory' ? podLevel('container_memory_working_set_bytes', place) : podLevelRate('container_cpu_usage_seconds_total', place);
  const joined = `${perPod} * on(namespace, pod) group_left(${VIRTUAL_NAMESPACE_LABEL}, ${VIRTUAL_NAME_ANNOTATION}) ${named}`;
  const renamed = `label_replace(label_replace(${joined}, "namespace", "$1", "${VIRTUAL_NAMESPACE_LABEL}", "(.+)"), "pod", "$1", "${VIRTUAL_NAME_ANNOTATION}", "(.+)")`;
  return `sum by (namespace, pod) (${renamed})`;
}

export const APP_CHARTS = ['up', 'responseSeconds', 'memoryShare', 'cpuShare', 'requestsPerSecond', 'errorShare'] as const;
export type AppChart = typeof APP_CHARTS[number];

export function appChartQuery(chart: AppChart, app: AppSubject, place?: PoolPlace): string | undefined {
  if (chart === 'memoryShare') return `(${appQuery('memoryBytes', app, place)}) / (${appQuery('memoryLimitBytes', app, place)})`;
  if (chart === 'cpuShare') return `(${appQuery('cpuCores', app, place)}) / (${appQuery('cpuLimitCores', app, place)})`;
  return appQuery(chart, app, place);
}

export const CLUSTER_CHARTS = ['cpuShare', 'memoryShare', 'diskShare'] as const;
export type ClusterChart = typeof CLUSTER_CHARTS[number];

export const clusterChartQuery = (chart: ClusterChart, place?: PoolPlace): string => clusterQuery(chart, place);

export const KOALA_QUESTIONS = [
  'reporting', 'requestsPerSecond', 'requestErrorShare', 'requestSeconds', 'modelCallsPerMinute', 'modelErrorShare', 'modelSeconds', 'modelQueued',
  'workflowsStartedHour', 'activityFailuresHour', 'workFailuresDay',
] as const;
export type KoalaQuestion = typeof KOALA_QUESTIONS[number];

export const KOALA_UP = 'koala_up';
const KOALA_FAILED_SHARE = (metric: string, failing: string, window: string) =>
  `(sum(rate(${metric}{${failing}}[${window}])) or vector(0)) / sum(rate(${metric}[${window}]))`;
const KOALA_BACKEND_UP = `sum(${KOALA_UP}{service_name="koala-backend"})`;
const zeroWhile = (counted: string, measured: string) => `${counted} or (0 * ${measured})`;

export function koalaQuery(question: KoalaQuestion): string {
  switch (question) {
    case 'reporting': return `count(sum by (service_name) (${KOALA_UP}))`;
    case 'requestsPerSecond': return 'sum(rate(koala_http_request_seconds_count[5m]))';
    case 'requestErrorShare': return KOALA_FAILED_SHARE('koala_http_request_seconds_count', 'status=~"5.."', '5m');
    case 'requestSeconds': return 'histogram_quantile(0.95, sum by (le) (rate(koala_http_request_seconds_bucket[5m])))';
    case 'modelCallsPerMinute': return 'sum(rate(koala_model_call_seconds_count[5m])) * 60';
    case 'modelErrorShare': return KOALA_FAILED_SHARE('koala_model_call_seconds_count', 'outcome="failed"', '5m');
    case 'modelSeconds': return 'histogram_quantile(0.95, sum by (le) (rate(koala_model_call_seconds_bucket[5m])))';
    case 'modelQueued': return 'sum(koala_model_queued)';
    case 'workflowsStartedHour': return zeroWhile('sum(increase(koala_workflows_started_total[1h]))', KOALA_BACKEND_UP);
    case 'activityFailuresHour': return zeroWhile('sum(increase(koala_activity_seconds_count{outcome="failed"}[1h]))', 'sum(increase(koala_activity_seconds_count[1h]))');
    case 'workFailuresDay': return zeroWhile('sum(increase(koala_work_failures_total[24h]))', KOALA_BACKEND_UP);
  }
}

export const koalaServicesQuery = (): string => `sum by (service_name) (${KOALA_UP})`;
