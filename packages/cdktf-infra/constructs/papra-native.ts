import { Construct, Namespace, appDeployment, type DeploymentSpecTemplateSpec, Service, PersistentVolumeClaim, type VpnConfig, createAppIngress, createAppProbe, defaultServiceType } from "../lib/native-app.js";

export interface PapraNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly dataStorage?: string;
  readonly mediaStorage?: string;
  readonly serviceType?: string;
}

export class PapraNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: PapraNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "papra-native";
    const webImage = `${config.webRepo || "ghcr.io/papra-hq/papra"}:${config.webTag || "latest"}`;
    const dataSize = config.dataStorage || "2Gi";
    const mediaSize = config.mediaStorage || "5Gi";

    const serviceType = config.serviceType || defaultServiceType();

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const dataPvc = new PersistentVolumeClaim(this, "data-pvc", {
      metadata: {
        name: "papra-data-pvc",
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

    const mediaPvc = new PersistentVolumeClaim(this, "media-pvc", {
      metadata: {
        name: "papra-media-pvc",
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

    const podSpec: DeploymentSpecTemplateSpec = {
      container: [
        {
          name: "papra",
          image: webImage,
          port: [{ containerPort: 1221 }],
          volumeMount: [
            {
              name: "data-vol",
              mountPath: "/data",
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
          name: "data-vol",
          persistentVolumeClaim: {
            claimName: dataPvc.metadata.name,
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

    appDeployment(this, "papra-deployment", { name: "papra", namespace: ns.metadata.name, label: `papra-${id}`, pod: podSpec, vpn: config });

    new Service(this, "papra-service", {
      metadata: {
        name: "papra",
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: { app: `papra-${id}` },
        port: [{ port: 1221, targetPort: "1221" }],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "papra",
      servicePort: 1221,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "papra",
      servicePort: 1221,
    });
  }
}
