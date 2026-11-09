import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { NetworkPolicyV1 } from "../.gen/providers/kubernetes/network-policy-v1/index.js";
import { LOKI_VALUES, PROMTAIL_VALUES } from "../lib/logging-values.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";

export class LoggingStack extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Release(this, "loki-release", {
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      name: "loki",
      repository: "https://grafana.github.io/helm-charts",
      chart: "loki",
      version: "7.3.0",
      namespace: "monitoring",
      values: [JSON.stringify(LOKI_VALUES)],
    });

    new Release(this, "promtail-release", {
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      name: "promtail",
      repository: "https://grafana.github.io/helm-charts",
      chart: "promtail",
      version: "6.17.1",
      namespace: "monitoring",
      values: [JSON.stringify(PROMTAIL_VALUES)],
    });

    new NetworkPolicyV1(this, "loki-netpol", {
      metadata: {
        name: "loki-restrict-ingress",
        namespace: "monitoring",
      },
      spec: {
        podSelector: {
          matchLabels: {
            "app.kubernetes.io/instance": "loki",
          },
        },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { "app.kubernetes.io/instance": "loki" } } },
              { podSelector: { matchLabels: { "app.kubernetes.io/name": "grafana" } } },
              { podSelector: { matchLabels: { "app.kubernetes.io/name": "promtail" } } },
            ],
          },
        ],
      },
    });
  }
}
