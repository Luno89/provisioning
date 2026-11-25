import { Construct, Namespace, appDeployment, type DeploymentSpecTemplateSpec, Service, PersistentVolumeClaim, type VpnConfig, defaultServiceType, exposeApp } from "../lib/native-app.js";

export interface PlexNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly configStorage?: string;
  readonly mediaStorage?: string;
  readonly serviceType?: string;
}

export class PlexNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: PlexNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "plex-native";
    const webImage = `${config.webRepo || "plexinc/pms-docker"}:${config.webTag || "latest"}`;
    const configSize = config.configStorage || "2Gi";
    const mediaSize = config.mediaStorage || "10Gi";

    const serviceType = config.serviceType || defaultServiceType();

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

    const podSpec: DeploymentSpecTemplateSpec = {
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

    appDeployment(this, "plex-deployment", { name: "plex", namespace: ns.metadata.name, label: `plex-${id}`, pod: podSpec, vpn: config });

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

    exposeApp(this, {
      namespace: ns,
      serviceName: "plex",
      servicePort: 32400,
      hostname: `${namespaceName}.apps.local`,
    });
  }
}
