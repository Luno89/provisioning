import { Construct, Namespace, appDeployment, type DeploymentSpecTemplateSpec, Service, PersistentVolumeClaim, type VpnConfig, defaultServiceType, exposeApp } from "../lib/native-app.js";

export interface NavidromeNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly dataStorage?: string;
  readonly musicStorage?: string;
  readonly serviceType?: string;
}

export class NavidromeNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: NavidromeNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "navidrome-native";
    const webImage = `${config.webRepo || "deluan/navidrome"}:${config.webTag || "latest"}`;
    const dataSize = config.dataStorage || "2Gi";
    const musicSize = config.musicStorage || "5Gi";

    const serviceType = config.serviceType || defaultServiceType();

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

    const podSpec: DeploymentSpecTemplateSpec = {
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

    appDeployment(this, "navidrome-deployment", { name: "navidrome", namespace: ns.metadata.name, label: `navidrome-${id}`, pod: podSpec, vpn: config });

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

    exposeApp(this, {
      namespace: ns,
      serviceName: "navidrome",
      servicePort: 4533,
      hostname: `${namespaceName}.apps.local`,
    });
  }
}
