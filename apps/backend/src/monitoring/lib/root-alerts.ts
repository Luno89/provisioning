import { KOALA_ALERT_NAMESPACE, RULE_LABEL } from './monitoring-alerts.js';

export interface RootAlert {
  id: string;
  alert: string;
  expr: string;
  forMinutes: number;
  summary: string;
}

export const ROOT_SERVICES = ['caddy', 'mongo', 'postgres', 'temporal', 'headscale', 'registry', 'mail'] as const;

export const ROOT_PROCESSES = [
  { service: 'koala-backend', name: 'Root\'s backend' },
  { service: 'koala-worker-host', name: 'Root\'s host worker' },
] as const;

const ROOT_DISK = 'node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}';

export const BACKUP_STALE_HOURS = 36;

export const ROOT_ALERTS: readonly RootAlert[] = [
  ...ROOT_PROCESSES.map((process) => ({
    id: `root-${process.service}-down`,
    alert: 'Root_process_down',
    expr: `absent(koala_up{service_name="${process.service}",koala_role="root"})`,
    forMinutes: 5,
    summary: `${process.name} has not reported for 5 minutes`,
  })),
  ...ROOT_SERVICES.map((service) => ({
    id: `root-${service}-down`,
    alert: 'Root_service_down',
    expr: `up{service="${service}"} == 0 or absent(up{service="${service}"})`,
    forMinutes: 5,
    summary: `${service[0]!.toUpperCase()}${service.slice(1)} on root has not answered for 5 minutes`,
  })),
  { id: 'root-disk', alert: 'Root_disk_full', expr: `${ROOT_DISK} < 0.1`, forMinutes: 10, summary: 'Root\'s disk is more than 90% full' },
  { id: 'root-memory', alert: 'Root_memory_low', expr: 'node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1', forMinutes: 10, summary: 'Root has less than 10% of its memory free' },
  { id: 'root-workflow-failures', alert: 'Root_workflow_failures', expr: 'sum(increase(koala_work_failures_total{koala_role="root"}[1h])) > 5', forMinutes: 0, summary: 'More than 5 pieces of root\'s work failed in the last hour' },
  { id: 'root-backup-stale', alert: 'Root_backup_stale', expr: `time() - koala_root_backup_last_success_seconds > ${BACKUP_STALE_HOURS * 3600}`, forMinutes: 0, summary: `Root's last good backup is more than ${BACKUP_STALE_HOURS} hours old` },
  { id: 'root-backup-none', alert: 'Root_backup_none', expr: 'absent(koala_root_backup_last_success_seconds)', forMinutes: BACKUP_STALE_HOURS * 60, summary: `Root has made no good backup in ${BACKUP_STALE_HOURS} hours (is BACKUP_REPOSITORY set?)` },
];

export const ROOT_RULE_IDS: ReadonlySet<string> = new Set(ROOT_ALERTS.map((alert) => alert.id));

export const ROOT_RULES_NAME = 'koala-root-alerts';

const rulesManifest = (name: string, alerts: readonly RootAlert[]): Record<string, unknown> => ({
  apiVersion: 'monitoring.coreos.com/v1',
  kind: 'PrometheusRule',
  metadata: { name, namespace: KOALA_ALERT_NAMESPACE, labels: { release: 'kube-prometheus-stack', 'koala.dev/alert-rule': name } },
  spec: {
    groups: [{
      name,
      rules: alerts.map((rule) => ({
        alert: rule.alert,
        expr: rule.expr,
        for: `${rule.forMinutes}m`,
        labels: { severity: 'critical', [RULE_LABEL]: rule.id },
        annotations: { summary: rule.summary },
      })),
    }],
  },
});

export const rootAlertsManifest = (): Record<string, unknown> => rulesManifest(ROOT_RULES_NAME, ROOT_ALERTS);

export const INSTANCE_PROCESSES = [
  { service: 'koala-worker-engine', name: 'The engine worker, which runs your chats, agents and checks' },
  { service: 'koala-worker-cluster', name: 'The cluster worker, which deploys your apps' },
  { service: 'koala-worker-host', name: 'The host worker, which runs server orders' },
] as const;

export const INSTANCE_ALERTS: readonly RootAlert[] = INSTANCE_PROCESSES.map((process) => ({
  id: `instance-${process.service}-down`,
  alert: 'Instance_worker_down',
  expr: `absent(koala_up{service_name="${process.service}",koala_role="instance"})`,
  forMinutes: 5,
  summary: `${process.name}, has not reported for 5 minutes`,
}));

export const INSTANCE_RULE_IDS: ReadonlySet<string> = new Set(INSTANCE_ALERTS.map((alert) => alert.id));

export const INSTANCE_RULES_NAME = 'koala-instance-alerts';

export const instanceAlertsManifest = (): Record<string, unknown> => rulesManifest(INSTANCE_RULES_NAME, INSTANCE_ALERTS);
