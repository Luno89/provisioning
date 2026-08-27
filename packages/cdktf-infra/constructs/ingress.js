import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
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
    constructor(scope, id, dependsOn) {
        super(scope, id);
        const ns = new Namespace(this, "ingress-ns", {
            metadata: {
                name: "traefik",
            },
        });
        // NOT the KUBECONFIG_CONTEXT-based check app constructs use — that env var is only ever
        // set by app-deploy activities (app-env.ts, DestroyAppActivity, etc.), never by
        // ProvisionClusterActivity, which is what actually applies this construct (STACK_TYPE=
        // cluster). Confirmed live: using it here always fell through to LoadBalancer, even for
        // k3d/native-k3s. ProvisionClusterActivity sets ENV instead (`isMock ? 'local' :
        // args.provider`) — the exact same signal constructs/cluster.ts's own BaseCluster already
        // uses for its identical isLocal check, so mirror that instead.
        const isLocal = process.env.ENV === "local" || process.env.ENV === "k3d";
        // Same per-cluster-type decision every app construct makes for its own Service (NodePort
        // for k3d/native-k3s, LoadBalancer for real cloud) — not ClusterIP. AppExposureService
        // needs to reach this Service from the HOST the same way it already reaches every app's
        // own Service, via the identical k3d-server-ip / host-gateway-ip / cloud-LB resolution — a
        // ClusterIP Service has no NodePort at all and isn't reachable that way.
        const serviceType = isLocal ? "NodePort" : "LoadBalancer";
        new Release(this, "traefik-release", {
            name: "traefik",
            repository: "https://traefik.github.io/charts",
            chart: "traefik",
            namespace: ns.metadata.name,
            timeout: 600,
            atomic: true,
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
