import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";

/**
 * Installed once per cluster into the `monitoring` namespace (co-located with
 * Prometheus/Grafana, MonitoringStack) — every app's Probe CR (lib/app-probe.ts) points at this
 * same Service by a fixed, predictable name.
 */
export class BlackboxExporterStack extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Release(this, "blackbox-exporter-release", {
      name: "blackbox-exporter",
      repository: "https://prometheus-community.github.io/helm-charts",
      chart: "prometheus-blackbox-exporter",
      namespace: "monitoring",
      timeout: 300,
      // Chart defaults to naming everything "<release>-prometheus-blackbox-exporter" (confirmed
      // live via `helm template`) — fullnameOverride keeps the Service name short and
      // predictable so lib/app-probe.ts's Probe targets don't need to know the chart's naming
      // convention. Default `config.modules.http_2xx` module (confirmed live via `helm show
      // values`) works as-is — no custom values needed.
      set: [
        {
          name: "fullnameOverride",
          value: "blackbox-exporter",
        },
      ],
    });
  }
}
