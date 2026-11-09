import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { BlackboxExporterStack } from "./blackbox-exporter.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";

export const METRICS_TOKEN_SECRET = "koala-metrics";

export function agentValues(remoteWriteUrl: string): Record<string, unknown> {
  return {
    grafana: { enabled: false },
    alertmanager: { enabled: false },
    defaultRules: { create: false },
    kubeControllerManager: { enabled: false },
    kubeScheduler: { enabled: false },
    kubeEtcd: { enabled: false },
    kubeProxy: { enabled: false },
    prometheus: {
      agentMode: true,
      prometheusSpec: {
        remoteWrite: [{ url: remoteWriteUrl, authorization: { type: "Bearer", credentials: { name: METRICS_TOKEN_SECRET, key: "token" } } }],
      },
    },
  };
}

export class AgentMonitoringStack extends Construct {
  public readonly prometheusRelease: Release;

  constructor(scope: Construct, id: string, remoteWriteUrl: string) {
    super(scope, id);
    this.prometheusRelease = new Release(this, "prometheus-agent", {
      name: "kube-prometheus-stack",
      repository: "https://prometheus-community.github.io/helm-charts",
      chart: "kube-prometheus-stack",
      version: "88.6.2",
      namespace: "monitoring",
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      values: [JSON.stringify(agentValues(remoteWriteUrl))],
    });
    new BlackboxExporterStack(this, "blackbox").node.addDependency(this.prometheusRelease);
  }
}
