import { randomBytes } from "node:crypto";
import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class Crawl4aiNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "crawl4ai";
        const image = `${config.webRepo || "unclecode/crawl4ai"}:${config.webTag || "latest"}`;
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const memoryLimit = config.memoryLimit || "4Gi";
        const shmSize = config.shmSize || "1Gi";
        const ns = new Namespace(this, "ns", {
            metadata: { name: namespaceName },
        });
        const apiToken = config.apiToken || randomBytes(32).toString("hex");
        const secret = new Secret(this, "secret", {
            metadata: { name: "crawl4ai-secret", namespace: ns.metadata.name },
            // Plaintext — the provider base64-encodes `data` itself (see searxng-native.ts).
            data: { api_token: apiToken },
            type: "Opaque",
        });
        const podSpec = {
            container: [
                {
                    name: "crawl4ai",
                    image,
                    env: [
                        {
                            name: "CRAWL4AI_API_TOKEN",
                            valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "api_token" } },
                        },
                        { name: "CRAWL4AI_PORT", value: "11235" },
                    ],
                    port: [{ containerPort: 11235 }],
                    volumeMount: [{ name: "shm", mountPath: "/dev/shm" }],
                    resources: {
                        limits: { memory: memoryLimit, cpu: "2000m" },
                        // A request well under the limit on purpose: the pod is idle most of the time and
                        // only spikes while a page renders. Requesting the peak would reserve several GB
                        // permanently on a node that is also holding a 20GB model.
                        requests: { memory: "512Mi", cpu: "200m" },
                    },
                },
            ],
            volume: [
                {
                    name: "shm",
                    // Memory-backed, like /dev/shm actually is. Note this counts against the container's
                    // memory limit — the same trap that OOMKilled the TabbyAPI pod when its shm was sized
                    // without accounting for it.
                    emptyDir: { medium: "Memory", sizeLimit: shmSize },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "crawl4ai-deployment", {
            metadata: {
                name: "crawl4ai",
                namespace: ns.metadata.name,
                labels: { app: `crawl4ai-${id}` },
            },
            spec: {
                replicas: "1",
                selector: { matchLabels: { app: `crawl4ai-${id}` } },
                template: {
                    metadata: { labels: { app: `crawl4ai-${id}` } },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "crawl4ai-service", {
            metadata: { name: "crawl4ai", namespace: ns.metadata.name },
            spec: {
                type: serviceType,
                selector: { app: `crawl4ai-${id}` },
                port: [{ port: 11235, targetPort: "11235" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "crawl4ai",
            servicePort: 11235,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "crawl4ai",
            servicePort: 11235,
            // Every other route sits behind the auth gate and answers 401, which blackbox-exporter would
            // report as down forever. `/health` is one of the two paths the gate leaves public.
            path: "/health",
        });
    }
}
