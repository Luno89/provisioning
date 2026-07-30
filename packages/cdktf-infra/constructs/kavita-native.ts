import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { type VpnConfig, VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

export interface KavitaNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly configStorage?: string;
  readonly mangaStorage?: string;
  readonly serviceType?: string;
}

export class KavitaNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: KavitaNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "kavita-native";
    const webImage = `${config.webRepo || "ghcr.io/kareadita/kavita"}:${config.webTag || "latest"}`;
    const configSize = config.configStorage || "2Gi";
    const mangaSize = config.mangaStorage || "5Gi";

    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const configPvc = new PersistentVolumeClaim(this, "config-pvc", {
      metadata: {
        name: "kavita-config-pvc",
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

    const mangaPvc = new PersistentVolumeClaim(this, "manga-pvc", {
      metadata: {
        name: "kavita-manga-pvc",
        namespace: ns.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: mangaSize,
          },
        },
      },
      waitUntilBound: false,
    });

    const podSpec: any = {
      container: [
        {
          name: "kavita",
          image: webImage,
          port: [{ containerPort: 5000 }],
          volumeMount: [
            {
              name: "config-vol",
              mountPath: "/kavita/config",
            },
            {
              name: "manga-vol",
              mountPath: "/manga",
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
          name: "manga-vol",
          persistentVolumeClaim: {
            claimName: mangaPvc.metadata.name,
          },
        },
      ],
    };

    VpnService.apply(this, ns.metadata.name, podSpec, config);

    new Deployment(this, "kavita-deployment", {
      metadata: {
        name: "kavita",
        namespace: ns.metadata.name,
        labels: { app: `kavita-${id}` },
      },
      spec: {
        replicas: "1",
        selector: {
          matchLabels: { app: `kavita-${id}` },
        },
        template: {
          metadata: {
            labels: { app: `kavita-${id}` },
          },
          spec: podSpec,
        },
      },
    });

    new Service(this, "kavita-service", {
      metadata: {
        name: "kavita",
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: { app: `kavita-${id}` },
        port: [{ port: 5000, targetPort: "5000" }],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "kavita",
      servicePort: 5000,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "kavita",
      servicePort: 5000,
    });
  }
}
