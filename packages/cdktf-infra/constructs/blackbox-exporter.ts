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
      // convention.
      set: [
        {
          name: "fullnameOverride",
          value: "blackbox-exporter",
        },
      ],
      // The chart ships exactly one module, `http_2xx`. Supplying `config` REPLACES that default
      // wholesale rather than merging, so http_2xx is redeclared verbatim here — dropping it
      // would break every existing web app's probe.
      //
      // tcp_connect exists for game servers (see lib/app-probe.ts's `module` option): they have
      // no HTTP surface, and blackbox has no UDP prober, so "can we open a TCP connection to the
      // control/API port" is the closest available liveness signal.
      //
      // NOTE: existing clusters need their ObservabilityStack re-applied before a tcp_connect
      // probe will succeed — otherwise the module is unknown and the probe reports down forever,
      // firing alerting.ts's AppProbeDown.
      values: [
        [
          "config:",
          "  modules:",
          "    http_2xx:",
          "      prober: http",
          "      timeout: 5s",
          "      http:",
          "        valid_http_versions: [\"HTTP/1.1\", \"HTTP/2.0\"]",
          "        follow_redirects: true",
          "        preferred_ip_protocol: ip4",
          "    tcp_connect:",
          "      prober: tcp",
          "      timeout: 5s",
          "      tcp:",
          "        preferred_ip_protocol: ip4",
          "",
        ].join("\n"),
      ],
    });
  }
}
