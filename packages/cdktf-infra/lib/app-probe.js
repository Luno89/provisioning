import { Manifest } from "../.gen/providers/kubernetes/manifest/index.js";
/**
 * Every app construct calls this right after createAppIngress (lib/app-ingress.ts), giving
 * blackbox-exporter (constructs/blackbox-exporter.ts) a target to HTTP-probe on a fixed interval
 * — this is what actually detects "the app is down" independent of whether it's currently
 * receiving real traffic (Traefik's own request/error metrics, Phase 2, only tell you about
 * requests that happened; a probe still fires with zero real users hitting the app).
 *
 * Targets the app's own Service directly via Kubernetes' automatic in-cluster DNS
 * (<service>.<namespace>.svc.cluster.local:<port>), not the app's `.apps.local` Ingress
 * hostname — that hostname is only a Traefik routing key (see app-ingress.ts), not a real DNS
 * record, so blackbox-exporter running in-cluster can't resolve it.
 */
export function createAppProbe(scope, id, config) {
    const target = `${config.serviceName}.${config.namespace}.svc.cluster.local:${config.servicePort}`;
    return new Manifest(scope, id, {
        manifest: {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "Probe",
            metadata: {
                name: "app",
                namespace: config.namespace,
                // Mandatory — Prometheus Operator's probeSelector only watches Probes carrying this
                // exact label (confirmed live: `kubectl get prometheus -o jsonpath='{...probeSelector}'`
                // == {matchLabels: {release: kube-prometheus-stack}}), same convention already
                // established for every ServiceMonitor/PodMonitor/PrometheusRule this session.
                labels: {
                    release: "kube-prometheus-stack",
                },
            },
            spec: {
                prober: {
                    url: "blackbox-exporter.monitoring.svc.cluster.local:9115",
                },
                module: config.module ?? "http_2xx",
                targets: {
                    staticConfig: {
                        static: [target],
                        // Carried onto the resulting probe_success series so it's filterable the same way
                        // as every other per-app panel/rule this session (dashboards.ts's $namespace
                        // variable, alerting.ts's AppProbeDown rule).
                        labels: {
                            namespace: config.namespace,
                            app: config.serviceName,
                        },
                    },
                },
            },
        },
    });
}
