import { Construct } from "constructs";
import { ConfigMapV1 } from "../.gen/providers/kubernetes/config-map-v1/index.js";
import { TEMPO_HTTP_PORT, TEMPO_NAME } from "./telemetry.js";

const DASHBOARD_LABEL = { grafana_dashboard: "1" };
const DATASOURCE_LABEL = { grafana_datasource: "1" };
const PROMETHEUS = { type: "prometheus", uid: "prometheus" };
export const TEMPO_DATASOURCE_UID = "tempo";

interface Panel {
  title: string;
  expr: string | string[];
  legend?: string | string[];
  unit?: string;
  w?: number;
}

function timeseries(panels: Panel[]): object[] {
  let x = 0;
  let y = 0;
  return panels.map((panel, index) => {
    const w = panel.w ?? 12;
    if (x + w > 24) { x = 0; y += 8; }
    const gridPos = { h: 8, w, x, y };
    x += w;
    const exprs = Array.isArray(panel.expr) ? panel.expr : [panel.expr];
    const legends = Array.isArray(panel.legend) ? panel.legend : [panel.legend ?? ""];
    return {
      id: index + 1,
      title: panel.title,
      type: "timeseries",
      datasource: PROMETHEUS,
      gridPos,
      ...(panel.unit ? { fieldConfig: { defaults: { unit: panel.unit }, overrides: [] } } : {}),
      targets: exprs.map((expr, at) => ({ expr, legendFormat: legends[at] ?? legends[0] ?? "", refId: String.fromCharCode(65 + at) })),
    };
  });
}

const dashboard = (title: string, uid: string, panels: Panel[]): object => ({
  title,
  uid,
  tags: ["koala"],
  timezone: "browser",
  schemaVersion: 39,
  version: 1,
  time: { from: "now-1h", to: "now" },
  refresh: "30s",
  panels: timeseries(panels),
});

export const koalaServiceDashboard = (): object => dashboard("Koala: the service", "koala-service", [
  { title: "Requests per second, by service", expr: "sum by (service_name) (rate(koala_http_request_seconds_count[5m]))", legend: "{{service_name}}", unit: "reqps" },
  { title: "Requests failing (5xx share)", expr: 'sum(rate(koala_http_request_seconds_count{status=~"5.."}[5m])) / sum(rate(koala_http_request_seconds_count[5m]))', legend: "failing", unit: "percentunit" },
  { title: "Request time p95, by route", expr: "histogram_quantile(0.95, sum by (le, route) (rate(koala_http_request_seconds_bucket[5m])))", legend: "{{route}}", unit: "s" },
  { title: "Work that failed, by kind", expr: "sum by (kind) (increase(koala_work_failures_total[1h]))", legend: "{{kind}}" },
  { title: "Tool calls per minute, by tool", expr: "sum by (tool) (rate(koala_tool_call_seconds_count[5m])) * 60", legend: "{{tool}}" },
  { title: "Tool call time p95, by tool", expr: "histogram_quantile(0.95, sum by (le, tool) (rate(koala_tool_call_seconds_bucket[5m])))", legend: "{{tool}}", unit: "s" },
  { title: "Sandbox provisioning time p95", expr: "histogram_quantile(0.95, sum by (le, outcome) (rate(koala_sandbox_provision_seconds_bucket[15m])))", legend: "{{outcome}}", unit: "s" },
  { title: "Image builds, time p95 by kind", expr: "histogram_quantile(0.95, sum by (le, kind) (rate(koala_image_build_seconds_bucket[1h])))", legend: "{{kind}}", unit: "s" },
  { title: "Hub sync time, by step", expr: "sum by (step) (rate(koala_hub_sync_seconds_sum[5m])) / sum by (step) (rate(koala_hub_sync_seconds_count[5m]))", legend: "{{step}}", unit: "s" },
  { title: "Emails sent, by outcome", expr: "sum by (outcome) (increase(koala_mail_sent_total[1h]))", legend: "{{outcome}}" },
  { title: "Processes reporting", expr: "sum by (service_name) (koala_up)", legend: "{{service_name}}" },
  { title: "Telemetry relayed from machines", expr: "sum by (signal, outcome) (rate(koala_telemetry_relayed_total[5m]))", legend: "{{signal}} {{outcome}}" },
]);

export const koalaModelCallsDashboard = (): object => dashboard("Koala: model calls", "koala-model-calls", [
  { title: "Calls per minute, by provider and model", expr: "sum by (provider, model) (rate(koala_model_call_seconds_count[5m])) * 60", legend: "{{provider}} {{model}}" },
  { title: "Calls failing, by provider", expr: 'sum by (provider) (rate(koala_model_call_seconds_count{outcome="failed"}[5m])) / sum by (provider) (rate(koala_model_call_seconds_count[5m]))', legend: "{{provider}}", unit: "percentunit" },
  { title: "Call time p50 and p95", expr: ["histogram_quantile(0.5, sum by (le, provider) (rate(koala_model_call_seconds_bucket[5m])))", "histogram_quantile(0.95, sum by (le, provider) (rate(koala_model_call_seconds_bucket[5m])))"], legend: ["{{provider}} p50", "{{provider}} p95"], unit: "s" },
  { title: "Tokens per minute, by kind", expr: "sum by (provider, kind) (rate(koala_model_tokens_total[5m])) * 60", legend: "{{provider}} {{kind}}" },
  { title: "Waiting in the queue", expr: "sum by (provider) (koala_model_queued)", legend: "{{provider}}" },
  { title: "Queue wait p95", expr: "histogram_quantile(0.95, sum by (le, provider) (rate(koala_model_queue_wait_seconds_bucket[5m])))", legend: "{{provider}}", unit: "s" },
  { title: "Servers saying they are busy (429)", expr: "sum by (provider) (increase(koala_model_rate_limit_pauses_total[1h]))", legend: "{{provider}}" },
  { title: "Connections lost and asked again", expr: "sum by (provider) (increase(koala_model_connection_losses_total[1h]))", legend: "{{provider}}" },
]);

export const koalaTemporalDashboard = (): object => dashboard("Koala: Temporal", "koala-temporal", [
  { title: "Workflows started per hour, by type", expr: "sum by (workflow_type) (increase(koala_workflows_started_total[1h]))", legend: "{{workflow_type}}" },
  { title: "Activities per minute, by outcome", expr: "sum by (outcome) (rate(koala_activity_seconds_count[5m])) * 60", legend: "{{outcome}}" },
  { title: "Activity time p95, by type", expr: "histogram_quantile(0.95, sum by (le, activity_type) (rate(koala_activity_seconds_bucket[5m])))", legend: "{{activity_type}}", unit: "s" },
  { title: "Activity retries per hour, by type", expr: "sum by (activity_type) (increase(koala_activity_retries_total[1h]))", legend: "{{activity_type}}" },
  { title: "Late heartbeats, by how late (p95)", expr: "histogram_quantile(0.95, sum by (le, activity_type) (rate(koala_activity_heartbeat_gap_seconds_bucket[15m])))", legend: "{{activity_type}}", unit: "s" },
  { title: "Workflows Temporal closed as failed", expr: "sum by (task_queue) (rate(temporal_workflow_failed[5m]))", legend: "{{task_queue}}" },
]);

export const ROOT_SERVICES = ["caddy", "mongo", "postgres", "temporal", "headscale", "registry", "mail"] as const;

export const koalaRootDashboard = (): object => dashboard("Koala: root", "koala-root", [
  { title: "Each service on root answering (1 up, 0 down)", expr: `max by (service) (up{service=~"${ROOT_SERVICES.join("|")}"})`, legend: "{{service}}", w: 24 },
  { title: "Hours since the last good backup", expr: "(time() - max(koala_root_backup_last_success_seconds)) / 3600", legend: "hours", unit: "h" },
  { title: "Memory each service holds", expr: `sum by (service) (process_resident_memory_bytes{service=~"${ROOT_SERVICES.join("|")}"})`, legend: "{{service}}", unit: "bytes" },
  { title: "Host disk free on /", expr: 'min(node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})', legend: "free", unit: "percentunit" },
  { title: "Host memory available", expr: "min(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)", legend: "available", unit: "percentunit" },
  { title: "Caddy requests per second, by host", expr: "sum by (host) (rate(caddy_http_requests_total[5m]))", legend: "{{host}}", unit: "reqps" },
  { title: "Mongo connections and operations", expr: ['sum(mongodb_ss_connections{conn_type="current"})', "sum by (legacy_op_type) (rate(mongodb_ss_opcounters[5m]))"], legend: ["connections", "{{legacy_op_type}} per second"] },
  { title: "Postgres backends and size, by database", expr: ["sum by (datname) (pg_stat_database_numbackends)", "sum by (datname) (pg_database_size_bytes) / 1e9"], legend: ["{{datname}} backends", "{{datname}} GB"] },
  { title: "Temporal requests and errors per second", expr: ["sum(rate(service_requests_total[5m]))", "sum(rate(service_errors_total[5m]))"], legend: ["requests", "errors"], unit: "reqps" },
  { title: "Temporal backlog, by task queue", expr: "sum by (taskqueue) (approximate_backlog_count)", legend: "{{taskqueue}}" },
  { title: "Registry requests per second, by handler", expr: "sum by (handler) (rate(registry_http_requests_total[5m]))", legend: "{{handler}}", unit: "reqps" },
  { title: "Mail server connect time", expr: "max(tcpcheck_duration_milliseconds)", legend: "connect", unit: "ms" },
]);

export const tempoDatasource = (): string => [
  "apiVersion: 1",
  "datasources:",
  "  - name: Tempo",
  "    type: tempo",
  `    uid: ${TEMPO_DATASOURCE_UID}`,
  "    access: proxy",
  `    url: http://${TEMPO_NAME}.monitoring.svc.cluster.local:${TEMPO_HTTP_PORT}`,
  "    isDefault: false",
  "    editable: false",
  "    jsonData:",
  "      tracesToMetrics:",
  "        datasourceUid: prometheus",
  "      serviceMap:",
  "        datasourceUid: prometheus",
  "",
].join("\n");

export class KoalaDashboardsStack extends Construct {
  constructor(scope: Construct, id: string, namespace: string) {
    super(scope, id);

    for (const [name, build] of [["koala-service", koalaServiceDashboard], ["koala-model-calls", koalaModelCallsDashboard], ["koala-temporal", koalaTemporalDashboard], ["koala-root", koalaRootDashboard]] as const) {
      new ConfigMapV1(this, `${name}-dashboard`, {
        metadata: { name: `dashboard-${name}`, namespace, labels: DASHBOARD_LABEL },
        data: { [`${name}.json`]: JSON.stringify(build(), null, 2) },
      });
    }

    new ConfigMapV1(this, "tempo-datasource", {
      metadata: { name: "datasource-tempo", namespace, labels: DATASOURCE_LABEL },
      data: { "tempo.yaml": tempoDatasource() },
    });
  }
}
