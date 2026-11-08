import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release";
import { Namespace } from "../.gen/providers/kubernetes/namespace";

export class MonitoringStack extends Construct {
  /**
   * The kube-prometheus-stack release, exposed so IngressStack can declare an explicit dependency
   * on it. Traefik's chart renders a ServiceMonitor, which needs the monitoring.coreos.com CRDs
   * this release installs — without an ordering edge Terraform is free to apply them in parallel
   * and Traefik fails to render. See ClusterStack in main.ts.
   */
  public readonly prometheusRelease: Release;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const ns = new Namespace(this, "monitoring-ns", {
      metadata: {
        name: "monitoring",
      },
    });

    this.prometheusRelease = new Release(this, "prometheus-stack", {
      name: "kube-prometheus-stack",
      repository: "https://prometheus-community.github.io/helm-charts",
      chart: "kube-prometheus-stack",
      version: "88.6.2",
      namespace: ns.metadata.name,
      wait: false,
      set: [
        {
          name: "grafana.enabled",
          value: "true",
        },
        ...(process.env.KOALA_CLUSTER === "true" ? [{ name: "prometheus.prometheusSpec.enableRemoteWriteReceiver", value: "true" }] : []),
      ],
    });
  }
}
