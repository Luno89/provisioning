import crypto from 'crypto';
import { alertExpression, alertSpec, isAlertKind, RULE_LABEL, ruleResourceName, type AlertSpec, type PromAlert } from './monitoring-alerts.js';
import { PROBE_NAMESPACE_LABEL, type PoolPlace } from './monitoring-questions.js';

export const POOL_MONITORING = {
  namespace: 'monitoring',
  stack: { release: 'kube-prometheus-stack', chart: 'kube-prometheus-stack', version: '91.7.0' },
  blackbox: { release: 'blackbox-exporter', chart: 'prometheus-blackbox-exporter', version: '11.19.1' },
  repo: 'https://prometheus-community.github.io/helm-charts',
  prometheusService: 'kube-prometheus-stack-prometheus:9090',
  historyDays: 10,
} as const;

export const PROBE_MODULES = ['http_2xx', 'tcp_connect'] as const;
export type ProbeModule = typeof PROBE_MODULES[number];

export const POOL_PROBE_LABEL = 'koala.dev/pool-probe';
export const POOL_RULE_LABEL = 'koala.dev/pool-rule';

export interface PoolProbe {
  namespace: string;
  service: string;
  port: number;
  path: string;
  module: ProbeModule;
}

export interface PoolRule {
  id: string;
  namespace: string;
  spec: AlertSpec;
  summary: string;
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PATH = /^\/[A-Za-z0-9\-._~/%?=&+]{0,200}$/;
const TARGET = /^([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)\.([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)\.svc\.cluster\.local:(\d{1,5})(\/.*)?$/;
const MAX_PROBES = 200;

const isModule = (value: unknown): value is ProbeModule => typeof value === 'string' && (PROBE_MODULES as readonly string[]).includes(value);

function probeOf(value: unknown): PoolProbe | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { namespace, service, port, path, module } = value as Record<string, unknown>;
  if (typeof namespace !== 'string' || !NAME.test(namespace) || typeof service !== 'string' || !NAME.test(service)) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof path !== 'string' || (path !== '' && !PATH.test(path)) || !isModule(module)) return undefined;
  return { namespace, service, port, path, module };
}

export function parseProbes(value: unknown): PoolProbe[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PROBES) return undefined;
  const probes = value.map(probeOf);
  return probes.every((probe): probe is PoolProbe => Boolean(probe)) ? probes : undefined;
}

export function probesFromCluster(json: string): PoolProbe[] {
  const items = (JSON.parse(json) as { items?: Array<{ metadata?: { namespace?: string }; spec?: { module?: string; targets?: { staticConfig?: { static?: string[] } } } }> }).items ?? [];
  const probes: PoolProbe[] = [];
  for (const item of items) {
    const module = item.spec?.module ?? 'http_2xx';
    if (!isModule(module)) continue;
    for (const target of item.spec?.targets?.staticConfig?.static ?? []) {
      const found = TARGET.exec(target);
      if (!found || found[3] !== item.metadata?.namespace) continue;
      const probe = probeOf({ namespace: found[3], service: found[1], port: Number(found[5]), path: found[6] ?? '', module });
      if (probe) probes.push(probe);
    }
  }
  return probes.sort((a, b) => `${a.namespace}/${a.service}`.localeCompare(`${b.namespace}/${b.service}`));
}

export const probesKey = (probes: readonly PoolProbe[]): string => crypto.createHash('sha256').update(JSON.stringify(probes)).digest('hex');

export const probeResourceName = (probe: Pick<PoolProbe, 'namespace' | 'service'>): string =>
  `koala-probe-${crypto.createHash('sha256').update(`${probe.namespace}/${probe.service}`).digest('hex').slice(0, 16)}`;

export function hostProbeManifest(place: PoolPlace, probe: PoolProbe, hostService: string): Record<string, unknown> {
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'Probe',
    metadata: {
      name: probeResourceName(probe),
      namespace: place.hostNamespace,
      labels: { release: POOL_MONITORING.stack.release, [POOL_PROBE_LABEL]: 'true' },
    },
    spec: {
      prober: { url: `${POOL_MONITORING.blackbox.release}.${POOL_MONITORING.namespace}.svc.cluster.local:9115` },
      module: probe.module,
      targets: {
        staticConfig: {
          static: [`${hostService}.${place.hostNamespace}.svc.cluster.local:${probe.port}${probe.path}`],
          labels: { [PROBE_NAMESPACE_LABEL]: probe.namespace, app: probe.service },
        },
      },
    },
  };
}

export function parsePoolRule(id: string, value: unknown): PoolRule | { error: string } {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return { error: 'an alert is named by its id' };
  if (!value || typeof value !== 'object') return { error: 'an alert needs its app\'s namespace, what it watches and its summary' };
  const { namespace, spec, summary } = value as Record<string, unknown>;
  if (typeof namespace !== 'string' || !NAME.test(namespace)) return { error: 'the app\'s namespace is not a namespace' };
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 300) return { error: 'an alert says what it is in one line' };
  const raw = spec as { kind?: unknown; threshold?: unknown; forMinutes?: unknown } | undefined;
  if (!raw || !isAlertKind(raw.kind)) return { error: 'that is not a kind of alert Koala sets' };
  const checked = alertSpec(raw.kind, typeof raw.threshold === 'number' ? raw.threshold : undefined, typeof raw.forMinutes === 'number' ? raw.forMinutes : undefined);
  if ('error' in checked) return checked;
  return { id, namespace, spec: checked, summary: summary.trim() };
}

export function hostRuleManifest(place: PoolPlace, rule: PoolRule): Record<string, unknown> | { error: string } {
  const expression = alertExpression(rule.spec, { namespace: rule.namespace }, place);
  if (typeof expression !== 'string') return expression;
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'PrometheusRule',
    metadata: {
      name: ruleResourceName(rule.id),
      namespace: place.hostNamespace,
      labels: { release: POOL_MONITORING.stack.release, [POOL_RULE_LABEL]: 'true' },
    },
    spec: {
      groups: [{
        name: ruleResourceName(rule.id),
        rules: [{
          alert: `Koala_${rule.spec.kind}`,
          expr: expression,
          for: `${rule.spec.forMinutes}m`,
          labels: { severity: 'warning', [RULE_LABEL]: rule.id, [PROBE_NAMESPACE_LABEL]: rule.namespace },
          annotations: { summary: rule.summary },
        }],
      }],
    },
  };
}

export function probeIngressPolicy(name: string, place: PoolPlace): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'koala-probes', namespace: place.hostNamespace },
    spec: {
      podSelector: { matchLabels: { 'vcluster.loft.sh/managed-by': name } },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': POOL_MONITORING.namespace } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus-blackbox-exporter' } },
        }],
      }],
    },
  };
}

export function poolStackValues(): Record<string, unknown> {
  const own = (resource: string) => ({ group: 'monitoring.coreos.com', resource, namespace: POOL_MONITORING.namespace });
  return {
    grafana: { enabled: false },
    alertmanager: { enabled: false },
    'kube-state-metrics': {
      metricLabelsAllowlist: ['pods=[vcluster.loft.sh/namespace]', 'persistentvolumeclaims=[vcluster.loft.sh/namespace]'],
      metricAnnotationsAllowList: ['pods=[vcluster.loft.sh/object-name]'],
    },
    prometheus: {
      prometheusSpec: {
        retention: `${POOL_MONITORING.historyDays}d`,
        retentionSize: '18GB',
        storageSpec: { volumeClaimTemplate: { spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '20Gi' } } } } },
        enforcedNamespaceLabel: 'namespace',
        excludedFromEnforcement: [own('servicemonitors'), own('podmonitors'), own('prometheusrules'), own('probes')],
        probeSelectorNilUsesHelmValues: true,
        ruleSelectorNilUsesHelmValues: true,
      },
    },
  };
}

export function poolAppAlerts(): Record<string, unknown> {
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'PrometheusRule',
    metadata: { name: 'pool-app-alerts', namespace: POOL_MONITORING.namespace, labels: { release: POOL_MONITORING.stack.release } },
    spec: {
      groups: [{
        name: 'pool-app-health',
        rules: [{
          alert: 'AppProbeDown',
          expr: `probe_success{${PROBE_NAMESPACE_LABEL}!=""} == 0`,
          for: '2m',
          labels: { severity: 'warning' },
          annotations: { summary: '{{ $labels.app }} is not answering' },
        }],
      }],
    },
  };
}

export const BLACKBOX_VALUES = [
  'fullnameOverride: blackbox-exporter',
  'config:',
  '  modules:',
  '    http_2xx:',
  '      prober: http',
  '      timeout: 5s',
  '      http:',
  '        valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]',
  '        follow_redirects: false',
  '        preferred_ip_protocol: ip4',
  '    tcp_connect:',
  '      prober: tcp',
  '      timeout: 5s',
  '      tcp:',
  '        preferred_ip_protocol: ip4',
  '',
].join('\n');

export function placeAlerts(alerts: readonly PromAlert[], place: PoolPlace, namespaceOfPod: ReadonlyMap<string, string>): PromAlert[] {
  const seen: PromAlert[] = [];
  for (const alert of alerts) {
    if (alert.labels.namespace !== place.hostNamespace) continue;
    const virtual = alert.labels[PROBE_NAMESPACE_LABEL] ?? (alert.labels.pod ? namespaceOfPod.get(alert.labels.pod) : undefined);
    if (!virtual) continue;
    const labels = Object.fromEntries(Object.entries(alert.labels).filter(([name]) => name !== PROBE_NAMESPACE_LABEL));
    seen.push({ ...alert, labels: { ...labels, namespace: virtual } });
  }
  return seen;
}
