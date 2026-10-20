import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";

export const OPERATOR_CRDS_VERSION = "32.0.1";

export class OperatorCrdsStack extends Construct {
  public readonly prometheusRelease: Release;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const ns = new Namespace(this, "monitoring-ns", { metadata: { name: "monitoring" } });
    this.prometheusRelease = new Release(this, "operator-crds", {
      name: "prometheus-operator-crds",
      repository: "https://prometheus-community.github.io/helm-charts",
      chart: "prometheus-operator-crds",
      version: OPERATOR_CRDS_VERSION,
      namespace: ns.metadata.name,
    });
  }
}
