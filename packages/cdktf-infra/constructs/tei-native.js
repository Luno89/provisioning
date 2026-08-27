import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class TeiNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "tei";
        const useGpu = config.useGpu === true;
        const defaultTag = useGpu ? "1.8.1" : "cpu-1.8.1";
        const image = `${config.webRepo || "ghcr.io/huggingface/text-embeddings-inference"}:${config.webTag || defaultTag}`;
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const modelId = config.modelId || "BAAI/bge-small-en-v1.5";
        const memoryLimit = config.memoryLimit || "4Gi";
        const storage = config.storage || "10Gi";
        const ns = new Namespace(this, "ns", { metadata: { name: namespaceName } });
        const pvc = new PersistentVolumeClaim(this, "cache-pvc", {
            metadata: { name: "tei-cache-pvc", namespace: ns.metadata.name },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage } },
            },
            waitUntilBound: false,
        });
        const podSpec = {
            container: [
                {
                    name: "tei",
                    image,
                    args: [
                        "--model-id", modelId,
                        // float32 on CPU: the float16 kernels the default would pick are GPU-only, and the
                        // failure is at load time rather than at build time.
                        ...(useGpu ? [] : ["--dtype", "float32"]),
                        // Batching is where the throughput is. An ingest submits chunks in bulk, so a request
                        // waiting a few milliseconds for company is a good trade.
                        "--max-concurrent-requests", "64",
                    ],
                    env: [{ name: "HUGGINGFACE_HUB_CACHE", value: "/data" }],
                    port: [{ containerPort: 80, name: "http" }],
                    volumeMount: [{ name: "cache", mountPath: "/data" }],
                    resources: {
                        limits: {
                            memory: memoryLimit,
                            cpu: "4000m",
                            ...(useGpu ? { "nvidia.com/gpu": "1" } : {}),
                        },
                        requests: { memory: "1Gi", cpu: "500m" },
                    },
                    livenessProbe: {
                        httpGet: { path: "/health", port: "80" },
                        // The first start downloads the weights. Too short a delay here restarts the pod
                        // mid-download, forever, which presents as a model that never loads.
                        initialDelaySeconds: 60,
                        periodSeconds: 20,
                    },
                    readinessProbe: {
                        httpGet: { path: "/health", port: "80" },
                        initialDelaySeconds: 30,
                        periodSeconds: 10,
                        failureThreshold: 30,
                    },
                },
            ],
            volume: [{ name: "cache", persistentVolumeClaim: { claimName: pvc.metadata.name } }],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "tei-deployment", {
            metadata: { name: "tei", namespace: ns.metadata.name, labels: { app: `tei-${id}` } },
            spec: {
                replicas: "1",
                // ReadWriteOnce cache PVC: a rolling update would deadlock on the volume.
                strategy: { type: "Recreate" },
                selector: { matchLabels: { app: `tei-${id}` } },
                template: { metadata: { labels: { app: `tei-${id}` } }, spec: podSpec },
            },
        });
        new Service(this, "tei-service", {
            metadata: { name: "tei", namespace: ns.metadata.name },
            spec: {
                type: serviceType,
                selector: { app: `tei-${id}` },
                port: [{ port: 80, targetPort: "80", name: "http" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "tei",
            servicePort: 80,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "tei",
            servicePort: 80,
            path: "/health",
        });
    }
}
