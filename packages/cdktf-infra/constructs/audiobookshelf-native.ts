import { Construct, Namespace, appDeployment, type DeploymentSpecTemplateSpec, Service, PersistentVolumeClaim, type VpnConfig, defaultServiceType, exposeApp } from "../lib/native-app.js";

export interface AudiobookshelfNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly metadataStorage?: string;
  readonly configStorage?: string;
  readonly libraryStorage?: string;
  readonly serviceType?: string;
}

export class AudiobookshelfNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: AudiobookshelfNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "audiobookshelf-native";
    const webImage = `${config.webRepo || "ghcr.io/advplyr/audiobookshelf"}:${config.webTag || "latest"}`;
    const metadataSize = config.metadataStorage || "2Gi";
    const configSize = config.configStorage || "1Gi";
    const librarySize = config.libraryStorage || "5Gi";

    const serviceType = config.serviceType || defaultServiceType();

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

    const podSpec: DeploymentSpecTemplateSpec = {
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

    appDeployment(this, "audiobookshelf-deployment", { name: "audiobookshelf", namespace: ns.metadata.name, label: `audiobookshelf-${id}`, pod: podSpec, vpn: config });

    new Service(this, "audiobookshelf-service", {
      metadata: {
        name: "audiobookshelf",
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: { app: `audiobookshelf-${id}` },
        port: [{ port: 80, targetPort: "80" }],
      },
    });

    exposeApp(this, {
      namespace: ns,
      serviceName: "audiobookshelf",
      servicePort: 80,
      hostname: `${namespaceName}.apps.local`,
    });
  }
}
