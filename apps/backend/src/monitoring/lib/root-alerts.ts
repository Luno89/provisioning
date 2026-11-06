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
  { service: 'koala-worker-cluster', name: 'Root\'s cluster worker' },
  { service: 'koala-worker-engine', name: 'Root\'s engine worker' },
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
];

export const ROOT_RULE_IDS: ReadonlySet<string> = new Set(ROOT_ALERTS.map((alert) => alert.id));

export const ROOT_RULES_NAME = 'koala-root-alerts';

export function rootAlertsManifest(): Record<string, unknown> {
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'PrometheusRule',
    metadata: { name: ROOT_RULES_NAME, namespace: KOALA_ALERT_NAMESPACE, labels: { release: 'kube-prometheus-stack', 'koala.dev/alert-rule': ROOT_RULES_NAME } },
    spec: {
      groups: [{
        name: ROOT_RULES_NAME,
        rules: ROOT_ALERTS.map((rule) => ({
          alert: rule.alert,
          expr: rule.expr,
          for: `${rule.forMinutes}m`,
          labels: { severity: 'critical', [RULE_LABEL]: rule.id },
          annotations: { summary: rule.summary },
        })),
      }],
    },
  };
}
