import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class JellyfinNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "jellyfin-native";
        const webImage = `${config.webRepo || "jellyfin/jellyfin"}:${config.webTag || "latest"}`;
        const configSize = config.configStorage || "2Gi";
        const cacheSize = config.cacheStorage || "2Gi";
        const mediaSize = config.mediaStorage || "10Gi";
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const configPvc = new PersistentVolumeClaim(this, "config-pvc", {
            metadata: {
                name: "jellyfin-config-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: configSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const cachePvc = new PersistentVolumeClaim(this, "cache-pvc", {
            metadata: {
                name: "jellyfin-cache-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: cacheSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const mediaPvc = new PersistentVolumeClaim(this, "media-pvc", {
            metadata: {
                name: "jellyfin-media-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: mediaSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const podSpec = {
            container: [
                {
                    name: "jellyfin",
                    image: webImage,
                    port: [{ containerPort: 8096 }],
                    volumeMount: [
                        {
                            name: "config-vol",
                            mountPath: "/config",
                        },
                        {
                            name: "cache-vol",
                            mountPath: "/cache",
                        },
                        {
                            name: "media-vol",
                            mountPath: "/media",
                        },
                    ],
                },
            ],
            volume: [
                {
                    name: "config-vol",
                    persistentVolumeClaim: {
                        claimName: configPvc.metadata.name,
                    },
                },
                {
                    name: "cache-vol",
                    persistentVolumeClaim: {
                        claimName: cachePvc.metadata.name,
                    },
                },
                {
                    name: "media-vol",
                    persistentVolumeClaim: {
                        claimName: mediaPvc.metadata.name,
                    },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "jellyfin-deployment", {
            metadata: {
                name: "jellyfin",
                namespace: ns.metadata.name,
                labels: { app: `jellyfin-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `jellyfin-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `jellyfin-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "jellyfin-service", {
            metadata: {
                name: "jellyfin",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `jellyfin-${id}` },
                port: [{ port: 8096, targetPort: "8096" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "jellyfin",
            servicePort: 8096,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "jellyfin",
            servicePort: 8096,
        });
    }
}
