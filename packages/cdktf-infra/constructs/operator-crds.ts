import type { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";
import { chartRepository } from "../lib/chart-source.js";
import { InMonitoringNamespace } from "./owned-namespace.js";

export const OPERATOR_CRDS_VERSION = "32.0.1";

export class OperatorCrdsStack extends InMonitoringNamespace {
  public readonly prometheusRelease: Release;

  constructor(scope: Construct, id: string, existing: ReadonlySet<string>) {
    super(scope, id, existing);
    this.prometheusRelease = new Release(this, "operator-crds", {
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      name: "prometheus-operator-crds",
      repository: chartRepository("https://prometheus-community.github.io/helm-charts"),
      chart: "prometheus-operator-crds",
      version: OPERATOR_CRDS_VERSION,
      namespace: this.namespace.metadata.name,
    });
  }
}
