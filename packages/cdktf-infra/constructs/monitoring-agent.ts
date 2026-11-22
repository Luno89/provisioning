import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { BlackboxExporterStack } from "./blackbox-exporter.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";
import { chartRepository } from "../lib/chart-source.js";

// ── DUPLICATED, KNOWINGLY ── packages/engine-core/src/root-client.ts wins (METRICS_CLIENT_SECRET, METRICS_SCOPE); cdktf imports no other package, and the machine agent writes the Secret by that one.
export const METRICS_CLIENT_SECRET = { name: "koala-metrics", idKey: "client_id", secretKey: "client_secret" } as const;
export const METRICS_SCOPE = "koala:metrics";

export interface MetricsSending {
  url: string;
  tokenUrl: string;
  resource: string;
}

export function agentValues(sending: MetricsSending): Record<string, unknown> {
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
        remoteWrite: [{
          url: sending.url,
          oauth2: {
            clientId: { secret: { name: METRICS_CLIENT_SECRET.name, key: METRICS_CLIENT_SECRET.idKey } },
            clientSecret: { name: METRICS_CLIENT_SECRET.name, key: METRICS_CLIENT_SECRET.secretKey },
            tokenUrl: sending.tokenUrl,
            scopes: [METRICS_SCOPE],
            endpointParams: { resource: sending.resource },
          },
        }],
      },
    },
  };
}

export class AgentMonitoringStack extends Construct {
  public readonly prometheusRelease: Release;

  constructor(scope: Construct, id: string, sending: MetricsSending) {
    super(scope, id);
    this.prometheusRelease = new Release(this, "prometheus-agent", {
      name: "kube-prometheus-stack",
      repository: chartRepository("https://prometheus-community.github.io/helm-charts"),
      chart: "kube-prometheus-stack",
      version: "91.7.0",
      namespace: "monitoring",
      reuseValues: true,
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      values: [JSON.stringify(agentValues(sending))],
    });
    new BlackboxExporterStack(this, "blackbox").node.addDependency(this.prometheusRelease);
  }
}
