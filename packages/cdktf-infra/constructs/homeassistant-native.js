import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class HomeassistantNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "homeassistant-native";
        const webImage = `${config.webRepo || "ghcr.io/home-assistant/home-assistant"}:${config.webTag || "stable"}`;
        const configSize = config.configStorage || "2Gi";
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const configPvc = new PersistentVolumeClaim(this, "config-pvc", {
            metadata: {
                name: "homeassistant-config-pvc",
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
        const podSpec = {
            container: [
                {
                    name: "homeassistant",
                    image: webImage,
                    port: [{ containerPort: 8123 }],
                    volumeMount: [
                        {
                            name: "config-vol",
                            mountPath: "/config",
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
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "homeassistant-deployment", {
            metadata: {
                name: "homeassistant",
                namespace: ns.metadata.name,
                labels: { app: `homeassistant-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `homeassistant-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `homeassistant-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "homeassistant-service", {
            metadata: {
                name: "homeassistant",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `homeassistant-${id}` },
                port: [{ port: 8123, targetPort: "8123" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "homeassistant",
            servicePort: 8123,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "homeassistant",
            servicePort: 8123,
        });
    }
}
