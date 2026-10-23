import { describe, expect, it } from "vitest";
import { COLLECTOR_METRICS_PORT, COLLECTOR_VALUES, TEMPO_VALUES, collectorServiceMonitor } from "./telemetry.js";
import { koalaModelCallsDashboard, koalaServiceDashboard, koalaTemporalDashboard, tempoDatasource } from "./koala-dashboards.js";

type Panel = { title: string; targets: { expr: string }[] };

describe("the collector Koala reports to", () => {
  it("listens on ClusterIP only, with no host port, for OTLP over gRPC and HTTP", () => {
    expect(COLLECTOR_VALUES.service.type).toBe("ClusterIP");
    expect(COLLECTOR_VALUES.ports.otlp.hostPort).toBeNull();
    expect(COLLECTOR_VALUES.ports["otlp-http"].hostPort).toBeNull();
    for (const port of ["jaeger-compact", "jaeger-thrift", "jaeger-grpc", "zipkin"] as const) expect(COLLECTOR_VALUES.ports[port].enabled).toBe(false);
    expect(COLLECTOR_VALUES.alternateConfig.receivers.otlp.protocols.http.endpoint).toBe("${env:MY_POD_IP}:4318");
  });

  it("sends traces to Tempo and serves metrics for Prometheus to scrape, with the service name as a label", () => {
    const { pipelines } = COLLECTOR_VALUES.alternateConfig.service;
    expect(pipelines.traces.exporters).toEqual(["otlp/tempo"]);
    expect(pipelines.metrics.exporters).toEqual(["prometheus"]);
    expect(COLLECTOR_VALUES.alternateConfig.exporters["otlp/tempo"].endpoint).toBe("tempo.monitoring.svc.cluster.local:4317");
    expect(COLLECTOR_VALUES.alternateConfig.exporters.prometheus.endpoint).toBe(`0.0.0.0:${COLLECTOR_METRICS_PORT}`);
    expect(COLLECTOR_VALUES.alternateConfig.exporters.prometheus.resource_to_telemetry_conversion.enabled).toBe(true);
    expect(COLLECTOR_VALUES.alternateConfig.exporters.prometheus.metric_expiration).toBe("1m");
    expect(COLLECTOR_VALUES.ports["prom-exporter"]).toMatchObject({ enabled: true, servicePort: COLLECTOR_METRICS_PORT });
  });

  it("is scraped by the cluster's Prometheus through a ServiceMonitor it selects by the chart's release label", () => {
    const monitor = collectorServiceMonitor("monitoring");
    expect(monitor.metadata.labels).toEqual({ release: "kube-prometheus-stack" });
    expect(monitor.spec.endpoints).toEqual([{ port: "prom-exporter", path: "/metrics", interval: "15s", honorLabels: true }]);
    expect(monitor.spec.selector.matchLabels["app.kubernetes.io/instance"]).toBe("otel-collector");
  });

  it("keeps a week of traces in Tempo on a volume, ClusterIP only, phoning nobody home", () => {
    expect(TEMPO_VALUES.tempo.retention).toBe("168h");
    expect(TEMPO_VALUES.tempo.reportingEnabled).toBe(false);
    expect(TEMPO_VALUES.persistence).toEqual({ enabled: true, size: "10Gi" });
    expect(TEMPO_VALUES.service.type).toBe("ClusterIP");
    expect(tempoDatasource()).toContain("url: http://tempo.monitoring.svc.cluster.local:3200");
  });
});

describe("Koala's own dashboards", () => {
  it("read only Koala's and Temporal's metrics, every panel with a query", () => {
    for (const build of [koalaServiceDashboard, koalaModelCallsDashboard, koalaTemporalDashboard]) {
      const built = build() as { uid: string; panels: Panel[] };
      expect(built.uid).toMatch(/^koala-/);
      expect(built.panels.length).toBeGreaterThan(0);
      for (const panel of built.panels) {
        expect(panel.targets.length).toBeGreaterThan(0);
        for (const target of panel.targets) expect(target.expr, panel.title).toMatch(/koala_|temporal_/);
      }
      expect(() => JSON.parse(JSON.stringify(built))).not.toThrow();
    }
  });
});
