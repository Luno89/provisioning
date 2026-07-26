import { Construct } from "constructs";
import { ConfigMapV1 } from "../.gen/providers/kubernetes/config-map-v1/index.js";

// Grafana's dashboard sidecar (grafana-sc-dashboard container, part of the kube-prometheus-stack
// chart's Grafana subchart) watches ConfigMaps carrying this exact label across ALL namespaces
// and POSTs their contents to Grafana's provisioning-reload API. Confirmed live against the
// running deployment (kubectl get deploy kube-prometheus-stack-grafana -o yaml): LABEL=
// grafana_dashboard, LABEL_VALUE=1, NAMESPACE=ALL — chart default, identical on every cluster.
const DASHBOARD_LABEL = { grafana_dashboard: "1" };

// Sibling sidecar container (grafana-sc-datasources, same Grafana pod) watching for a different
// label — confirmed live via the same `kubectl get deploy ... -o yaml` check: LABEL=
// grafana_datasource, LABEL_VALUE=1, FOLDER=/etc/grafana/provisioning/datasources, NAMESPACE=
// ALL. Unlike the dashboard sidecar (which POSTs raw dashboard JSON), Grafana's datasource
// provisioning format is YAML, not JSON.
const DATASOURCE_LABEL = { grafana_datasource: "1" };

// Traefik's Kubernetes Ingress provider names each internal "service" `<namespace>-<k8s-service-
// name>-<port>@kubernetes` — confirmed live by generating real traffic through a test Ingress and
// reading Traefik's raw /metrics: `traefik_service_requests_total{service="metrics-verify-open-
// webui-8080@kubernetes"}`. By the time this reaches Prometheus, though, the label comes through
// as `exported_service`, not `service` — Prometheus Operator relabels a scraped metric's own
// `service` (and `namespace`/`pod`/`instance`/`job`) to `exported_<name>` whenever it collides
// with the label the ServiceMonitor itself injects to identify the scrape target (Traefik's own
// Service/pod, not the app being routed to). Confirmed live via Grafana's datasource proxy — the
// dashboard queries below use `exported_service`, the raw scrape used plain `service`. Every
// app's Ingress lives in a namespace unique to that deployment (see lib/app-ingress.ts), so
// `exported_service=~"$namespace-.*"` isolates one app's traffic without needing to know its
// exact Service name/port.
function appOverviewDashboard(): object {
  return {
    title: "App Overview",
    uid: "app-overview",
    tags: ["provisioning-platform"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    templating: {
      list: [
        {
          name: "namespace",
          type: "query",
          datasource: { type: "prometheus", uid: "prometheus" },
          query: { query: "label_values(kube_pod_info, namespace)", refId: "namespace" },
          current: {},
          includeAll: false,
          multi: false,
        },
      ],
    },
    panels: [
      {
        id: 1,
        title: "Pod Restarts",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        targets: [
          {
            expr: 'sum by (pod) (kube_pod_container_status_restarts_total{namespace="$namespace"})',
            legendFormat: "{{pod}}",
            refId: "A",
          },
        ],
      },
      {
        id: 2,
        title: "CPU Usage",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        fieldConfig: { defaults: { unit: "short" }, overrides: [] },
        targets: [
          {
            expr: 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="$namespace", container!=""}[5m]))',
            legendFormat: "{{pod}}",
            refId: "A",
          },
        ],
      },
      {
        id: 3,
        title: "Memory Usage",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
        targets: [
          {
            expr: 'sum by (pod) (container_memory_working_set_bytes{namespace="$namespace", container!=""})',
            legendFormat: "{{pod}}",
            refId: "A",
          },
        ],
      },
      {
        id: 4,
        title: "Request Rate (via Traefik)",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
        targets: [
          {
            expr: 'sum by (code) (rate(traefik_service_requests_total{exported_service=~"$namespace-.*"}[5m]))',
            legendFormat: "HTTP {{code}}",
            refId: "A",
          },
        ],
      },
      {
        id: 5,
        title: "5xx Error Rate (via Traefik)",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 0, y: 16 },
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
        targets: [
          {
            expr: 'sum(rate(traefik_service_requests_total{exported_service=~"$namespace-.*", code=~"5.."}[5m]))',
            legendFormat: "5xx",
            refId: "A",
          },
        ],
      },
      {
        id: 6,
        title: "p95 Request Latency (via Traefik)",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 12, y: 16 },
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
        targets: [
          {
            expr: 'histogram_quantile(0.95, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{exported_service=~"$namespace-.*"}[5m])))',
            legendFormat: "p95",
            refId: "A",
          },
        ],
      },
      {
        id: 7,
        title: "Probe Status",
        type: "stat",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 0, y: 24 },
        // blackbox-exporter probing the app's own Service directly (lib/app-probe.ts) — an
        // independent signal from the Traefik-traffic panels above, since it fires on a fixed
        // interval regardless of whether any real user request has happened recently.
        fieldConfig: {
          defaults: {
            mappings: [
              { type: "value", options: { "0": { text: "DOWN", color: "red" }, "1": { text: "UP", color: "green" } } },
            ],
            thresholds: { mode: "absolute", steps: [{ value: 0, color: "red" }, { value: 1, color: "green" }] },
          },
          overrides: [],
        },
        targets: [
          {
            expr: 'probe_success{namespace="$namespace"}',
            legendFormat: "{{app}}",
            refId: "A",
          },
        ],
      },
    ],
  };
}

// Workflow/activity execution counters (temporal_workflow_completed, _failed,
// temporal_activity_execution_failed, temporal_workflow_endtoend_latency, etc.) come from the
// shared Rust temporal-sdk-core the same way the poller/request metrics already confirmed live
// in worker-cluster.ts/worker-host.ts do — but unlike everything else in this plan, these
// specific names were NOT captured from a live scrape: they only register after a real workflow/
// activity actually executes on a metrics-instrumented worker, and forcing that would have meant
// restarting the live dev-stack worker processes (disruptive to a running `npm run dev`, and
// `concurrently --kill-others` means killing just the worker kills the whole dev stack). These
// names are the documented, stable Temporal SDK core metric surface — spot-check this dashboard
// against real data next time the worker processes restart naturally.
function temporalHealthDashboard(): object {
  return {
    title: "Temporal Workflow Health",
    uid: "temporal-workflow-health",
    tags: ["provisioning-platform"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Workflow Completions",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        targets: [
          {
            expr: 'sum by (task_queue) (rate(temporal_workflow_completed{}[5m]))',
            legendFormat: "{{task_queue}} completed",
            refId: "A",
          },
          {
            expr: 'sum by (task_queue) (rate(temporal_workflow_failed{}[5m]))',
            legendFormat: "{{task_queue}} failed",
            refId: "B",
          },
        ],
      },
      {
        id: 2,
        title: "Activity Failures",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        targets: [
          {
            expr: 'sum by (task_queue, activity_type) (rate(temporal_activity_execution_failed{}[5m]))',
            legendFormat: "{{task_queue}}/{{activity_type}}",
            refId: "A",
          },
        ],
      },
      {
        id: 3,
        title: "Workflow End-to-End Latency (p95)",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        fieldConfig: { defaults: { unit: "ms" }, overrides: [] },
        targets: [
          {
            expr: 'histogram_quantile(0.95, sum by (le, task_queue) (rate(temporal_workflow_endtoend_latency_bucket{}[5m])))',
            legendFormat: "{{task_queue}}",
            refId: "A",
          },
        ],
      },
      {
        id: 4,
        title: "Active Pollers",
        type: "timeseries",
        datasource: { type: "prometheus", uid: "prometheus" },
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        targets: [
          {
            expr: "temporal_num_pollers",
            legendFormat: "{{task_queue}}/{{poller_type}}",
            refId: "A",
          },
        ],
      },
    ],
  };
}

export class DashboardsStack extends Construct {
  constructor(scope: Construct, id: string, namespace: string) {
    super(scope, id);

    new ConfigMapV1(this, "app-overview-dashboard", {
      metadata: {
        name: "dashboard-app-overview",
        namespace,
        labels: DASHBOARD_LABEL,
      },
      data: {
        "app-overview.json": JSON.stringify(appOverviewDashboard()),
      },
    });

    new ConfigMapV1(this, "temporal-health-dashboard", {
      metadata: {
        name: "dashboard-temporal-workflow-health",
        namespace,
        labels: DASHBOARD_LABEL,
      },
      data: {
        "temporal-workflow-health.json": JSON.stringify(temporalHealthDashboard()),
      },
    });

    // "loki" Service, port 3100 — the SingleBinary-mode Service constructs/logging.ts's Loki
    // Release creates (confirmed live via `helm template ... single-binary-values.yaml`).
    // Queried directly, not through the chart's nginx "loki-gateway" — that gateway exists to
    // fan out between separate read/write/backend components in SimpleScalable/Distributed mode,
    // which don't exist here (one process handles everything in SingleBinary mode).
    new ConfigMapV1(this, "loki-datasource", {
      metadata: {
        name: "datasource-loki",
        namespace,
        labels: DATASOURCE_LABEL,
      },
      data: {
        "loki.yaml": [
          "apiVersion: 1",
          "datasources:",
          "  - name: Loki",
          "    type: loki",
          "    access: proxy",
          "    url: http://loki.monitoring.svc.cluster.local:3100",
          "    isDefault: false",
          "    jsonData:",
          "      maxLines: 1000",
        ].join("\n"),
      },
    });
  }
}
