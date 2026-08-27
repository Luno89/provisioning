import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class ImmichNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "immich-native";
        const webImage = `${config.webRepo || "ghcr.io/immich-app/immich-server"}:${config.webTag || "release"}`;
        const librarySize = config.libraryStorage || "10Gi";
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const libraryPvc = new PersistentVolumeClaim(this, "library-pvc", {
            metadata: {
                name: "immich-library-pvc",
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
                    name: "immich",
                    image: webImage,
                    port: [{ containerPort: 2283 }],
                    volumeMount: [
                        {
                            name: "library-vol",
                            mountPath: "/usr/src/app/upload",
                        },
                    ],
                },
            ],
            volume: [
                {
                    name: "library-vol",
                    persistentVolumeClaim: {
                        claimName: libraryPvc.metadata.name,
                    },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "immich-deployment", {
            metadata: {
                name: "immich",
                namespace: ns.metadata.name,
                labels: { app: `immich-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `immich-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `immich-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "immich-service", {
            metadata: {
                name: "immich",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `immich-${id}` },
                port: [{ port: 2283, targetPort: "2283" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "immich",
            servicePort: 2283,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "immich",
            servicePort: 2283,
        });
    }
}
