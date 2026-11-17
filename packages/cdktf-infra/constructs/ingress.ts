import { Construct } from "constructs";
import type { ITerraformDependable } from "cdktf";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";
import { chartRepository } from "../lib/chart-source.js";

export class IngressStack extends Construct {
  /**
   * @param dependsOn - the kube-prometheus-stack release (MonitoringStack.prometheusRelease).
   *   Traefik's chart renders a ServiceMonitor, which needs the monitoring.coreos.com/v1 CRDs that
   *   release installs. Terraform has no reason to order two independent Helm releases, so without
   *   this edge it may apply Traefik first and the render fails with
   *   "ERROR: You have to deploy monitoring.coreos.com/v1 first" — confirmed live on a fresh
   *   management cluster, which left it with no Traefik at all and silently broke app exposure
   *   (AppExposureService routes every exposed app through svc/traefik).
   */
  constructor(scope: Construct, id: string, dependsOn?: ITerraformDependable[]) {
    super(scope, id);

    const ns = new Namespace(this, "ingress-ns", {
      metadata: {
        name: "traefik",
      },
    });

    const serviceType = process.env.INGRESS_SERVICE;
    if (!serviceType) throw new Error("the cluster stack is told how Traefik's Service is reached, in INGRESS_SERVICE, and it was not");

    new Release(this, "traefik-release", {
      wait: false,
      timeout: HELM_CEILING_SECONDS,
      name: "traefik",
      repository: chartRepository("https://traefik.github.io/charts"),
      chart: "traefik",
      version: "41.4.0",
      namespace: ns.metadata.name,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
      cleanupOnFail: true,
      forceUpdate: true,
      values: [
        JSON.stringify({
          ingressClass: {
            enabled: true,
          },
          service: {
            spec: {
              type: serviceType,
            },
          },
          api: {
            dashboard: true,
            // dashboard:true alone only enables the dashboard *provider* internally — it
            // doesn't expose a route for it. Without an IngressRoute (which this platform
            // doesn't set up), the dashboard/API genuinely isn't reachable at all on the
            // "traefik" entrypoint. insecure:true is the documented dev-convenience flag that
            // opens it unauthenticated on that internal entrypoint — matches this platform's
            // existing local-dev security posture elsewhere (Mongo admin/admin, etc.), not
            // appropriate for a real multi-tenant deployment. Confirmed live.
            insecure: true,
          },
          // The chart already runs Traefik with metrics.prometheus enabled by default (port
          // 9100, entrypoint "metrics") — it was just never wired to anything. These three
          // keys are the chart's own built-in support for exactly this: a dedicated metrics
          // Service (kept separate from the main web/websecure Service so scraping doesn't
          // depend on NodePort/LoadBalancer plumbing) plus a ServiceMonitor CR, so no custom
          // `Manifest` resource is needed here. `additionalLabels.release` matches the mandatory
          // label Prometheus Operator's own selector requires (confirmed live earlier this
          // session: serviceMonitorSelector.matchLabels = {release: kube-prometheus-stack} —
          // chart-default, identical on every cluster since every cluster names its release the
          // same) — without it the ServiceMonitor exists but Prometheus silently ignores it.
          metrics: {
            prometheus: {
              addServicesLabels: true,
              service: {
                enabled: true,
              },
              serviceMonitor: {
                enabled: true,
                additionalLabels: {
                  release: "kube-prometheus-stack",
                },
              },
            },
          },
        }),
      ],
      set: [
        {
          name: "service.spec.type",
          value: serviceType,
        },
      ],
    });
  }
}
