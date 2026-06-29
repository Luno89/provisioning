import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
export class PrometheusApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "monitoring";
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "NodePort" : "LoadBalancer");
        const helmValues = [
            { name: "grafana.enabled", value: "true" },
            { name: "prometheus.prometheusSpec.service.type", value: serviceType }
        ];
        if (config.serverStorage) {
            helmValues.push({ name: "prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage", value: config.serverStorage });
        }
        if (config.webRepo) {
            helmValues.push({ name: "prometheus.prometheusSpec.image.repository", value: config.webRepo });
        }
        if (config.webTag) {
            helmValues.push({ name: "prometheus.prometheusSpec.image.tag", value: config.webTag });
        }
        new Release(this, "prometheus-release", {
            name: "prometheus",
            repository: "https://prometheus-community.github.io/helm-charts",
            chart: "kube-prometheus-stack",
            namespace: ns.metadata.name,
            timeout: 600,
            set: helmValues,
        });
    }
}
