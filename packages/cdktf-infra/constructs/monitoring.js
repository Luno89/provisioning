import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release";
import { Namespace } from "../.gen/providers/kubernetes/namespace";
export class MonitoringStack extends Construct {
    constructor(scope, id) {
        super(scope, id);
        const ns = new Namespace(this, "monitoring-ns", {
            metadata: {
                name: "monitoring",
            },
        });
        new Release(this, "prometheus-stack", {
            name: "kube-prometheus-stack",
            repository: "https://prometheus-community.github.io/helm-charts",
            chart: "kube-prometheus-stack",
            namespace: ns.metadata.name,
            set: [
                {
                    name: "grafana.enabled",
                    value: "true",
                },
            ],
        });
    }
}
