import { appQuery, appWindowQuery, trafficSelector, type AppSubject, type PoolPlace } from './monitoring-questions.js';

export interface PromAlert {
  labels: Record<string, string>;
  annotations?: Record<string, string> | undefined;
  state: string;
  activeAt?: string | undefined;
  value?: string | undefined;
}

export type AlertAbout = { kind: 'app'; deploymentId: string } | { kind: 'cluster' };

export interface VisibleAlert {
  key: string;
  name: string;
  summary: string;
  about: AlertAbout;
  ruleId?: string | undefined;
  since?: string | undefined;
  severity: string;
}

export interface AlertScope {
  appsByNamespace: ReadonlyMap<string, { deploymentId: string; name: string }>;
  ownRules: ReadonlySet<string>;
  ownsCluster: boolean;
}

export const RULE_LABEL = 'koala_rule';

const APP_ALERTS: Record<string, string> = {
  AppProbeDown: 'is not answering',
  KubePodCrashLooping: 'has a container that keeps restarting',
  KubeContainerWaiting: 'has a container stuck waiting to start',
  KubePodNotReady: 'has a pod that is not ready',
  KubeDeploymentReplicasMismatch: 'runs fewer copies than it asks for',
  KubeStatefulSetReplicasMismatch: 'runs fewer copies than it asks for',
  KubePersistentVolumeFillingUp: 'has a volume filling up',
  KubePersistentVolumeErrors: 'has a volume with errors',
};

const CLUSTER_ALERTS: Record<string, string> = {
  NodeFilesystemSpaceFillingUp: 'The disk is filling up',
  NodeFilesystemAlmostOutOfSpace: 'The disk is almost out of space',
  NodeFilesystemFilesFillingUp: 'The disk is running out of files',
  NodeMemoryHighUtilization: 'Memory is nearly full',
  NodeHighNumberConntrackEntriesUsed: 'The machine is running out of network connections',
  KubeNodeNotReady: 'A machine is not ready',
  KubeNodeUnreachable: 'A machine cannot be reached',
};

const KEY_LABELS = ['alertname', RULE_LABEL, 'namespace', 'instance', 'pod', 'container', 'persistentvolumeclaim', 'node', 'device', 'mountpoint'];

export const alertKey = (labels: Record<string, string>): string =>
  KEY_LABELS.filter((name) => labels[name]).map((name) => `${name}=${labels[name]}`).join(',');

export function visibleAlerts(alerts: readonly PromAlert[], scope: AlertScope): VisibleAlert[] {
  const seen: VisibleAlert[] = [];
  for (const alert of alerts) {
    if (alert.state !== 'firing') continue;
    const name = alert.labels.alertname ?? '';
    const app = alert.labels.namespace ? scope.appsByNamespace.get(alert.labels.namespace) : undefined;
    const ruleId = alert.labels[RULE_LABEL];
    const base = { key: alertKey(alert.labels), name, severity: alert.labels.severity ?? 'warning', ...(alert.activeAt ? { since: alert.activeAt } : {}) };
    if (ruleId) {
      if (!scope.ownRules.has(ruleId) || !app) continue;
      seen.push({ ...base, ruleId, summary: alert.annotations?.summary ?? `${app.name}: ${name}`, about: { kind: 'app', deploymentId: app.deploymentId } });
    } else if (app && APP_ALERTS[name]) {
      seen.push({ ...base, summary: `${app.name} ${APP_ALERTS[name]}`, about: { kind: 'app', deploymentId: app.deploymentId } });
    } else if (scope.ownsCluster && CLUSTER_ALERTS[name]) {
      seen.push({ ...base, summary: CLUSTER_ALERTS[name]!, about: { kind: 'cluster' } });
    }
  }
  return seen;
}

export const ALERT_KINDS = ['down', 'slow', 'memory', 'restarts', 'volume', 'errors'] as const;
export type AlertKind = typeof ALERT_KINDS[number];

export interface AlertSpec {
  kind: AlertKind;
  threshold: number;
  forMinutes: number;
}

interface KindRule {
  threshold: { default: number; min: number; max: number; unit: string } | undefined;
  forMinutes: number;
  describe: (app: string, spec: AlertSpec) => string;
}

const minutes = (n: number): string => `${n} minute${n === 1 ? '' : 's'}`;

export const ALERT_RULES: Record<AlertKind, KindRule> = {
  down: { threshold: undefined, forMinutes: 5, describe: (app, s) => `${app} has not answered for ${minutes(s.forMinutes)}` },
  slow: { threshold: { default: 2, min: 0.05, max: 120, unit: 'seconds' }, forMinutes: 10, describe: (app, s) => `${app} takes over ${s.threshold} s to answer for ${minutes(s.forMinutes)}` },
  memory: { threshold: { default: 90, min: 10, max: 100, unit: '% of its limit' }, forMinutes: 15, describe: (app, s) => `${app} uses over ${s.threshold}% of its memory limit for ${minutes(s.forMinutes)}` },
  restarts: { threshold: { default: 3, min: 1, max: 1000, unit: 'restarts in an hour' }, forMinutes: 0, describe: (app, s) => `${app} restarts more than ${s.threshold} times in an hour` },
  volume: { threshold: { default: 90, min: 10, max: 100, unit: '% full' }, forMinutes: 10, describe: (app, s) => `${app} has a volume over ${s.threshold}% full` },
  errors: { threshold: { default: 5, min: 0.1, max: 100, unit: '% of requests failing' }, forMinutes: 10, describe: (app, s) => `${app} fails over ${s.threshold}% of its requests for ${minutes(s.forMinutes)}` },
};

export const alertSummary = (app: string, spec: AlertSpec): string => ALERT_RULES[spec.kind].describe(app, spec);

export const isAlertKind = (value: unknown): value is AlertKind => typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value);

export function alertSpec(kind: AlertKind, threshold?: number, forMinutes?: number): AlertSpec | { error: string } {
  const rule = ALERT_RULES[kind];
  const t = threshold ?? rule.threshold?.default ?? 0;
  if (rule.threshold && (!Number.isFinite(t) || t < rule.threshold.min || t > rule.threshold.max)) {
    return { error: `the threshold for "${kind}" is in ${rule.threshold.unit}, between ${rule.threshold.min} and ${rule.threshold.max}` };
  }
  const minutes = forMinutes ?? rule.forMinutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return { error: 'forMinutes is whole minutes, from 0 to 1440' };
  return { kind, threshold: rule.threshold ? t : 0, forMinutes: minutes };
}

export function alertExpression(spec: AlertSpec, app: AppSubject, place?: PoolPlace): string | { error: string } {
  switch (spec.kind) {
    case 'down': return `${appQuery('up', app, place)} < 1`;
    case 'slow': return `${appQuery('responseSeconds', app, place)} > ${spec.threshold}`;
    case 'memory': return `(${appQuery('memoryBytes', app, place)}) / (${appQuery('memoryLimitBytes', app, place)}) > ${spec.threshold / 100}`;
    case 'restarts': return `${appWindowQuery('restarts', app, 3600, place)} > ${spec.threshold}`;
    case 'volume': return `${appQuery('volumeShare', app, place)} > ${spec.threshold / 100}`;
    case 'errors': {
      if (place) return { error: 'requests are not counted on Koala\'s servers, so failing requests cannot be watched there' };
      if (!trafficSelector(app)) return { error: 'this app has no service whose requests are counted, so failing requests cannot be watched' };
      return `${appQuery('errorShare', app)} > ${spec.threshold / 100}`;
    }
  }
}

export interface AlertRuleRecord {
  id: string;
  ownerId: string;
  deploymentId: string;
  clusterId: string;
  namespace: string;
  appName: string;
  spec: AlertSpec;
  summary: string;
  conversationId?: string | undefined;
  createdAt: string;
}

export const ruleResourceName = (id: string): string => `koala-alert-${id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;

export function alertRuleManifest(rule: AlertRuleRecord, expression: string): Record<string, unknown> {
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'PrometheusRule',
    metadata: {
      name: ruleResourceName(rule.id),
      namespace: rule.namespace,
      labels: { release: 'kube-prometheus-stack', 'koala.dev/owner': rule.ownerId, 'koala.dev/alert-rule': ruleResourceName(rule.id) },
    },
    spec: {
      groups: [{
        name: ruleResourceName(rule.id),
        rules: [{
          alert: `Koala_${rule.spec.kind}`,
          expr: expression,
          for: `${rule.spec.forMinutes}m`,
          labels: { severity: 'warning', [RULE_LABEL]: rule.id, namespace: rule.namespace },
          annotations: { summary: rule.summary },
        }],
      }],
    },
  };
}
