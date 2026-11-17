import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Manifest } from "../.gen/providers/kubernetes/manifest/index.js";
import { COLLECTOR_NAME, COLLECTOR_VALUES, TEMPO_NAME, TEMPO_VALUES, collectorServiceMonitor } from "./telemetry-values.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";
import { chartRepository } from "../lib/chart-source.js";

export * from "./telemetry-values.js";

export const COLLECTOR_CHART_VERSION = "0.177.0";
export const TEMPO_CHART_VERSION = "1.24.4";

export class TelemetryStack extends Construct {
  constructor(scope: Construct, id: string, namespace: string) {
    super(scope, id);

    new Release(this, "tempo-release", {
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      name: TEMPO_NAME,
      repository: chartRepository("https://grafana.github.io/helm-charts"),
      chart: "tempo",
      version: TEMPO_CHART_VERSION,
      namespace,
      values: [JSON.stringify(TEMPO_VALUES)],
    });

    new Release(this, "otel-collector-release", {
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      name: COLLECTOR_NAME,
      repository: chartRepository("https://open-telemetry.github.io/opentelemetry-helm-charts"),
      chart: "opentelemetry-collector",
      version: COLLECTOR_CHART_VERSION,
      namespace,
      values: [JSON.stringify(COLLECTOR_VALUES)],
    });

    new Manifest(this, "otel-collector-servicemonitor", { manifest: collectorServiceMonitor(namespace) });
  }
}
