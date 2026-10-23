import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Manifest } from "../.gen/providers/kubernetes/manifest/index.js";

export const COLLECTOR_CHART_VERSION = "0.177.0";
export const TEMPO_CHART_VERSION = "1.24.4";
export const COLLECTOR_NAME = "otel-collector";
export const TEMPO_NAME = "tempo";
export const COLLECTOR_OTLP_GRPC_PORT = 4317;
export const COLLECTOR_OTLP_HTTP_PORT = 4318;
export const COLLECTOR_METRICS_PORT = 8889;
export const TEMPO_HTTP_PORT = 3200;
export const TEMPO_RETENTION = "168h";

const noHostPort = { hostPort: null };

export const COLLECTOR_VALUES = {
  fullnameOverride: COLLECTOR_NAME,
  mode: "deployment",
  replicaCount: 1,
  image: { repository: "otel/opentelemetry-collector-contrib" },
  resources: {
    requests: { cpu: "50m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  ports: {
    otlp: { enabled: true, containerPort: COLLECTOR_OTLP_GRPC_PORT, servicePort: COLLECTOR_OTLP_GRPC_PORT, protocol: "TCP", appProtocol: "grpc", ...noHostPort },
    "otlp-http": { enabled: true, containerPort: COLLECTOR_OTLP_HTTP_PORT, servicePort: COLLECTOR_OTLP_HTTP_PORT, protocol: "TCP", ...noHostPort },
    "prom-exporter": { enabled: true, containerPort: COLLECTOR_METRICS_PORT, servicePort: COLLECTOR_METRICS_PORT, protocol: "TCP" },
    "jaeger-compact": { enabled: false },
    "jaeger-thrift": { enabled: false },
    "jaeger-grpc": { enabled: false },
    zipkin: { enabled: false },
  },
  service: { type: "ClusterIP" },
  alternateConfig: {
    receivers: {
      otlp: {
        protocols: {
          grpc: { endpoint: `\${env:MY_POD_IP}:${COLLECTOR_OTLP_GRPC_PORT}` },
          http: { endpoint: `\${env:MY_POD_IP}:${COLLECTOR_OTLP_HTTP_PORT}` },
        },
      },
    },
    processors: {
      memory_limiter: { check_interval: "5s", limit_percentage: 80, spike_limit_percentage: 25 },
      batch: {},
    },
    exporters: {
      "otlp/tempo": { endpoint: `${TEMPO_NAME}.monitoring.svc.cluster.local:${COLLECTOR_OTLP_GRPC_PORT}`, tls: { insecure: true } },
      prometheus: {
        endpoint: `0.0.0.0:${COLLECTOR_METRICS_PORT}`,
        resource_to_telemetry_conversion: { enabled: true },
        enable_open_metrics: false,
      },
    },
    extensions: {
      health_check: { endpoint: "${env:MY_POD_IP}:13133" },
    },
    service: {
      extensions: ["health_check"],
      pipelines: {
        traces: { receivers: ["otlp"], processors: ["memory_limiter", "batch"], exporters: ["otlp/tempo"] },
        metrics: { receivers: ["otlp"], processors: ["memory_limiter", "batch"], exporters: ["prometheus"] },
      },
    },
  },
};

export const TEMPO_VALUES = {
  fullnameOverride: TEMPO_NAME,
  tempo: {
    reportingEnabled: false,
    retention: TEMPO_RETENTION,
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
    receivers: {
      otlp: {
        protocols: {
          grpc: { endpoint: `0.0.0.0:${COLLECTOR_OTLP_GRPC_PORT}` },
          http: { endpoint: `0.0.0.0:${COLLECTOR_OTLP_HTTP_PORT}` },
        },
      },
    },
  },
  service: { type: "ClusterIP" },
  persistence: { enabled: true, size: "10Gi" },
};

export const collectorServiceMonitor = (namespace: string) => ({
  apiVersion: "monitoring.coreos.com/v1",
  kind: "ServiceMonitor",
  metadata: {
    name: COLLECTOR_NAME,
    namespace,
    labels: { release: "kube-prometheus-stack" },
  },
  spec: {
    selector: { matchLabels: { "app.kubernetes.io/instance": COLLECTOR_NAME, "app.kubernetes.io/name": "opentelemetry-collector", component: "standalone-collector" } },
    namespaceSelector: { matchNames: [namespace] },
    endpoints: [{ port: "prom-exporter", path: "/metrics", interval: "15s", honorLabels: true }],
  },
});

export class TelemetryStack extends Construct {
  constructor(scope: Construct, id: string, namespace: string) {
    super(scope, id);

    new Release(this, "tempo-release", {
      name: TEMPO_NAME,
      repository: "https://grafana.github.io/helm-charts",
      chart: "tempo",
      version: TEMPO_CHART_VERSION,
      namespace,
      timeout: 600,
      values: [JSON.stringify(TEMPO_VALUES)],
    });

    new Release(this, "otel-collector-release", {
      name: COLLECTOR_NAME,
      repository: "https://open-telemetry.github.io/opentelemetry-helm-charts",
      chart: "opentelemetry-collector",
      version: COLLECTOR_CHART_VERSION,
      namespace,
      timeout: 600,
      values: [JSON.stringify(COLLECTOR_VALUES)],
    });

    new Manifest(this, "otel-collector-servicemonitor", { manifest: collectorServiceMonitor(namespace) });
  }
}
