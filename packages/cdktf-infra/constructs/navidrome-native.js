import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class NavidromeNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "navidrome-native";
        const webImage = `${config.webRepo || "deluan/navidrome"}:${config.webTag || "latest"}`;
        const dataSize = config.dataStorage || "2Gi";
        const musicSize = config.musicStorage || "5Gi";
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const dataPvc = new PersistentVolumeClaim(this, "data-pvc", {
            metadata: {
                name: "navidrome-data-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: dataSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const musicPvc = new PersistentVolumeClaim(this, "music-pvc", {
            metadata: {
                name: "navidrome-music-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: musicSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const podSpec = {
            container: [
                {
                    name: "navidrome",
                    image: webImage,
                    env: [
                        { name: "ND_DATAFOLDER", value: "/data" },
                        { name: "ND_MUSICFOLDER", value: "/music" },
                        { name: "ND_PORT", value: "4533" },
                    ],
                    port: [{ containerPort: 4533 }],
                    volumeMount: [
                        {
                            name: "data-vol",
                            mountPath: "/data",
                        },
                        {
                            name: "music-vol",
                            mountPath: "/music",
                        },
                    ],
                },
            ],
            volume: [
                {
                    name: "data-vol",
                    persistentVolumeClaim: {
                        claimName: dataPvc.metadata.name,
                    },
                },
                {
                    name: "music-vol",
                    persistentVolumeClaim: {
                        claimName: musicPvc.metadata.name,
                    },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "navidrome-deployment", {
            metadata: {
                name: "navidrome",
                namespace: ns.metadata.name,
                labels: { app: `navidrome-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `navidrome-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `navidrome-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "navidrome-service", {
            metadata: {
                name: "navidrome",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `navidrome-${id}` },
                port: [{ port: 4533, targetPort: "4533" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "navidrome",
            servicePort: 4533,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "navidrome",
            servicePort: 4533,
        });
    }
}
