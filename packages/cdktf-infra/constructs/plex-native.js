import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class PlexNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "plex-native";
        const webImage = `${config.webRepo || "plexinc/pms-docker"}:${config.webTag || "latest"}`;
        const configSize = config.configStorage || "2Gi";
        const mediaSize = config.mediaStorage || "10Gi";
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const configPvc = new PersistentVolumeClaim(this, "config-pvc", {
            metadata: {
                name: "plex-config-pvc",
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
        const mediaPvc = new PersistentVolumeClaim(this, "media-pvc", {
            metadata: {
                name: "plex-media-pvc",
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
                    name: "plex",
                    image: webImage,
                    port: [{ containerPort: 32400 }],
                    volumeMount: [
                        {
                            name: "config-vol",
                            mountPath: "/config",
                        },
                        {
                            name: "media-vol",
                            mountPath: "/data",
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
                    name: "media-vol",
                    persistentVolumeClaim: {
                        claimName: mediaPvc.metadata.name,
                    },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "plex-deployment", {
            metadata: {
                name: "plex",
                namespace: ns.metadata.name,
                labels: { app: `plex-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `plex-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `plex-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "plex-service", {
            metadata: {
                name: "plex",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `plex-${id}` },
                port: [{ port: 32400, targetPort: "32400" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "plex",
            servicePort: 32400,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "plex",
            servicePort: 32400,
        });
    }
}
