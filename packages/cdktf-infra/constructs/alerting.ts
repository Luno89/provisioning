import { Construct } from "constructs";
import { Manifest } from "../.gen/providers/kubernetes/manifest/index.js";

/**
 * One PrometheusRule per cluster, installed alongside DashboardsStack — every rule here is
 * generic (namespace/service-labeled, not hardcoded to a specific app), so any app deployed
 * after this lands gets alert coverage for free, same principle as dashboards.ts's App Overview
 * dashboard. Alertmanager's current receiver is the chart-default "null" (confirmed live) —
 * alerts fire and are visible/queryable in the Alertmanager UI, nothing routed externally yet.
 */
export class AlertingStack extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Manifest(this, "app-alerts", {
      manifest: {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "PrometheusRule",
        metadata: {
          name: "app-alerts",
          namespace: "monitoring",
          labels: {
            release: "kube-prometheus-stack",
          },
        },
        spec: {
          groups: [
            {
              name: "app-health",
              rules: [
                {
                  alert: "AppProbeDown",
                  // From lib/app-probe.ts's per-app Probe — blackbox-exporter HTTP-checking
                  // each app's own Service directly, independent of whether it's currently
                  // getting real traffic.
                  expr: "probe_success == 0",
                  for: "2m",
                  labels: { severity: "warning" },
                  annotations: {
                    summary: "{{ $labels.namespace }}/{{ $labels.app }} is not responding to health probes",
                    description: "blackbox-exporter has failed to get a successful response from {{ $labels.namespace }}/{{ $labels.app }} for 2 minutes.",
                  },
                },
                {
                  alert: "AppHighErrorRate",
                  // exported_service, not service — Prometheus Operator relabels Traefik's own
                  // `service` label (identifying which internal Traefik router/service handled
                  // the request) to exported_service to avoid colliding with the `service` label
                  // it injects itself to identify the scrape target. Same quirk already
                  // documented in dashboards.ts's App Overview panels, confirmed live there.
                  expr: 'sum by (exported_service) (rate(traefik_service_requests_total{code=~"5.."}[5m])) / sum by (exported_service) (rate(traefik_service_requests_total[5m])) > 0.05',
                  for: "5m",
                  labels: { severity: "warning" },
                  annotations: {
                    summary: "{{ $labels.exported_service }} has a high 5xx rate",
                    description: "More than 5% of requests to {{ $labels.exported_service }} (via Traefik) have returned a 5xx status over the last 5 minutes.",
                  },
                },
                {
                  alert: "PodCrashLooping",
                  expr: "increase(kube_pod_container_status_restarts_total[15m]) > 3",
                  for: "5m",
                  labels: { severity: "warning" },
                  annotations: {
                    summary: "{{ $labels.namespace }}/{{ $labels.pod }} is crash-looping",
                    description: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} has restarted more than 3 times in the last 15 minutes.",
                  },
                },
                {
                  alert: "TemporalWorkflowFailures",
                  // Documented Temporal SDK core metric name, not yet confirmed against a real
                  // live execution — same caveat already flagged on dashboards.ts's Temporal
                  // Workflow Health panels for the identical reason (forcing a real execution
                  // would mean restarting the live dev-stack worker processes).
                  expr: "increase(temporal_workflow_failed[15m]) > 0",
                  for: "1m",
                  labels: { severity: "warning" },
                  annotations: {
                    summary: "Temporal workflow failures on {{ $labels.task_queue }}",
                    description: "At least one workflow failed on task queue {{ $labels.task_queue }} in the last 15 minutes.",
                  },
                },
              ],
            },
          ],
        },
      },
    });
  }
}
