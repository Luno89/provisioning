import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class HermesAgentApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "hermes";
        const webRepo = (config.webRepo && config.webRepo !== "library/odoo") ? config.webRepo : "nousresearch/hermes-agent";
        const webTag = (config.webTag && config.webTag !== "18.0") ? config.webTag : "latest";
        const image = `${webRepo}:${webTag}`;
        const storageSize = config.storage || "5Gi";
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const dataPvc = new PersistentVolumeClaim(this, "data-pvc", {
            metadata: {
                name: "hermes-data",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: storageSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const env = [
            { name: "HERMES_DASHBOARD", value: "true" },
            { name: "HERMES_DASHBOARD_HOST", value: "0.0.0.0" },
            { name: "HERMES_DASHBOARD_PORT", value: "9119" },
            { name: "HERMES_DASHBOARD_BASIC_AUTH_USERNAME", value: config.dashboardAuthUsername || "admin" },
            { name: "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", value: config.dashboardAuthPassword || "hermes123" },
            { name: "OPENAI_API_KEY", value: config.openaiApiKey || "not-needed" },
        ];
        if (config.openaiApiBaseUrl) {
            env.push({ name: "OPENAI_BASE_URL", value: config.openaiApiBaseUrl });
        }
        new Deployment(this, "hermes-deployment", {
            metadata: {
                name: "hermes",
                namespace: ns.metadata.name,
                labels: { app: `hermes-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `hermes-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `hermes-${id}` },
                    },
                    spec: {
                        container: [
                            {
                                name: "hermes",
                                image,
                                args: ["sleep", "infinity"],
                                env,
                                port: [{ containerPort: 9119 }],
                                resources: {
                                    limits: { cpu: "2", memory: "4G" },
                                    requests: { cpu: "500m", memory: "1G" },
                                },
                                volumeMount: [{ name: "data", mountPath: "/opt/data" }],
                                startupProbe: {
                                    httpGet: { path: "/api/health", port: "9119" },
                                    periodSeconds: 5,
                                    failureThreshold: 60, // ~5 min
                                },
                                livenessProbe: {
                                    httpGet: { path: "/api/health", port: "9119" },
                                    periodSeconds: 15,
                                    failureThreshold: 3,
                                },
                                readinessProbe: {
                                    tcpSocket: [{ port: "9119" }],
                                    periodSeconds: 10,
                                    failureThreshold: 3,
                                },
                            },
                        ],
                        volume: [
                            {
                                name: "data",
                                persistentVolumeClaim: {
                                    claimName: dataPvc.metadata.name,
                                },
                            },
                        ],
                    },
                },
            },
            timeouts: {
                create: "10m",
                update: "10m",
            },
        });
        new Service(this, "hermes-service", {
            metadata: {
                name: "hermes",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `hermes-${id}` },
                port: [{ port: 9119, targetPort: "9119" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "hermes",
            servicePort: 9119,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "hermes",
            servicePort: 9119,
            path: "/api/health",
        });
    }
}
