import { randomBytes } from "node:crypto";
import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class QdrantNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "qdrant";
        const image = `${config.webRepo || "qdrant/qdrant"}:${config.webTag || "latest"}`;
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const storage = config.storage || "50Gi";
        const memoryLimit = config.memoryLimit || "4Gi";
        const ns = new Namespace(this, "ns", { metadata: { name: namespaceName } });
        const apiKey = config.apiKey || randomBytes(32).toString("hex");
        const secret = new Secret(this, "secret", {
            metadata: { name: "qdrant-secret", namespace: ns.metadata.name },
            // Plaintext — the provider base64-encodes `data` itself (see searxng-native.ts).
            data: { api_key: apiKey },
            type: "Opaque",
        });
        const pvc = new PersistentVolumeClaim(this, "data-pvc", {
            metadata: { name: "qdrant-data-pvc", namespace: ns.metadata.name },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage } },
            },
            waitUntilBound: false,
        });
        const podSpec = {
            container: [
                {
                    name: "qdrant",
                    image,
                    env: [
                        {
                            // Without a key Qdrant serves unauthenticated, and this holds one tenant's corpus.
                            name: "QDRANT__SERVICE__API_KEY",
                            valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "api_key" } },
                        },
                        // Structured logs, so a failed upsert is greppable rather than prose.
                        { name: "QDRANT__LOG_LEVEL", value: "INFO" },
                    ],
                    port: [{ containerPort: 6333, name: "http" }, { containerPort: 6334, name: "grpc" }],
                    volumeMount: [{ name: "data", mountPath: "/qdrant/storage" }],
                    resources: {
                        limits: { memory: memoryLimit, cpu: "2000m" },
                        requests: { memory: "512Mi", cpu: "200m" },
                    },
                    livenessProbe: {
                        httpGet: { path: "/healthz", port: "6333" },
                        initialDelaySeconds: 10,
                        periodSeconds: 20,
                    },
                    readinessProbe: {
                        // `/readyz` waits for collections to load. On a large collection that is minutes after
                        // the process answers /healthz, and querying in between returns "not found" for data
                        // that is present.
                        httpGet: { path: "/readyz", port: "6333" },
                        initialDelaySeconds: 5,
                        periodSeconds: 10,
                    },
                },
            ],
            volume: [{ name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } }],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "qdrant-deployment", {
            metadata: { name: "qdrant", namespace: ns.metadata.name, labels: { app: `qdrant-${id}` } },
            spec: {
                replicas: "1",
                // ReadWriteOnce PVC: a rolling update would deadlock on a volume the old pod still holds.
                strategy: { type: "Recreate" },
                selector: { matchLabels: { app: `qdrant-${id}` } },
                template: { metadata: { labels: { app: `qdrant-${id}` } }, spec: podSpec },
            },
        });
        new Service(this, "qdrant-service", {
            metadata: { name: "qdrant", namespace: ns.metadata.name },
            spec: {
                type: serviceType,
                selector: { app: `qdrant-${id}` },
                port: [
                    { port: 6333, targetPort: "6333", name: "http" },
                    { port: 6334, targetPort: "6334", name: "grpc" },
                ],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "qdrant",
            servicePort: 6333,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "qdrant",
            servicePort: 6333,
            // Public: every other route needs the api-key header and would answer 401 forever, which
            // blackbox-exporter reports as down.
            path: "/healthz",
        });
    }
}
