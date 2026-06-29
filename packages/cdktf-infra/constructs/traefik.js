import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
export class TraefikApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "traefik";
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "ClusterIP" : "LoadBalancer");
        const configValues = {
            service: {
                spec: {
                    type: serviceType
                }
            },
            ingressClass: {
                enabled: false
            },
            ports: {
                web: {
                    port: 18080
                },
                websecure: {
                    port: 18443
                }
            }
        };
        if (config.webRepo) {
            configValues.image = configValues.image || {};
            configValues.image.repository = config.webRepo;
        }
        if (config.webTag) {
            configValues.image = configValues.image || {};
            configValues.image.tag = config.webTag;
        }
        new Release(this, "traefik-release", {
            name: "traefik",
            repository: "https://traefik.github.io/charts",
            chart: "traefik",
            namespace: ns.metadata.name,
            timeout: 600,
            values: [JSON.stringify(configValues)],
            set: [
                {
                    name: "service.spec.type",
                    value: serviceType,
                },
            ],
        });
    }
}
