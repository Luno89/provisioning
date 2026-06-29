import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
export class AudiobookshelfNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "audiobookshelf-native";
        const webImage = `${config.webRepo || "ghcr.io/advplyr/audiobookshelf"}:${config.webTag || "latest"}`;
        const metadataSize = config.metadataStorage || "2Gi";
        const configSize = config.configStorage || "1Gi";
        const librarySize = config.libraryStorage || "5Gi";
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const metadataPvc = new PersistentVolumeClaim(this, "metadata-pvc", {
            metadata: {
                name: "audiobookshelf-metadata-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: metadataSize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const configPvc = new PersistentVolumeClaim(this, "config-pvc", {
            metadata: {
                name: "audiobookshelf-config-pvc",
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
        const libraryPvc = new PersistentVolumeClaim(this, "library-pvc", {
            metadata: {
                name: "audiobookshelf-library-pvc",
                namespace: ns.metadata.name,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: {
                        storage: librarySize,
                    },
                },
            },
            waitUntilBound: false,
        });
        const podSpec = {
            container: [
                {
                    name: "audiobookshelf",
                    image: webImage,
                    env: [
                        { name: "PORT", value: "80" },
                        { name: "METADATA_PATH", value: "/metadata" },
                        { name: "CONFIG_PATH", value: "/config" },
                    ],
                    port: [{ containerPort: 80 }],
                    volumeMount: [
                        {
                            name: "metadata-vol",
                            mountPath: "/metadata",
                        },
                        {
                            name: "config-vol",
                            mountPath: "/config",
                        },
                        {
                            name: "library-vol",
                            mountPath: "/audiobooks",
                        },
                    ],
                },
            ],
            volume: [
                {
                    name: "metadata-vol",
                    persistentVolumeClaim: {
                        claimName: metadataPvc.metadata.name,
                    },
                },
                {
                    name: "config-vol",
                    persistentVolumeClaim: {
                        claimName: configPvc.metadata.name,
                    },
                },
                {
                    name: "library-vol",
                    persistentVolumeClaim: {
                        claimName: libraryPvc.metadata.name,
                    },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        // Audiobookshelf Deployment
        new Deployment(this, "audiobookshelf-deployment", {
            metadata: {
                name: "audiobookshelf",
                namespace: ns.metadata.name,
                labels: { app: `audiobookshelf-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `audiobookshelf-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `audiobookshelf-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "audiobookshelf-service", {
            metadata: {
                name: "audiobookshelf",
                namespace: ns.metadata.name,
            },
            spec: {
                type: "LoadBalancer",
                selector: { app: `audiobookshelf-${id}` },
                port: [{ port: 80, targetPort: "80" }],
            },
            waitForLoadBalancer: false,
        });
    }
}
