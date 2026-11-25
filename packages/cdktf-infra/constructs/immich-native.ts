import { Construct, Namespace, appDeployment, type DeploymentSpecTemplateSpec, Service, PersistentVolumeClaim, type VpnConfig, defaultServiceType, exposeApp } from "../lib/native-app.js";

export interface ImmichNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly libraryStorage?: string;
  readonly serviceType?: string;
}

export class ImmichNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: ImmichNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "immich-native";
    const webImage = `${config.webRepo || "ghcr.io/immich-app/immich-server"}:${config.webTag || "release"}`;
    const librarySize = config.libraryStorage || "10Gi";

    const serviceType = config.serviceType || defaultServiceType();

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

    const podSpec: DeploymentSpecTemplateSpec = {
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

    appDeployment(this, "immich-deployment", { name: "immich", namespace: ns.metadata.name, label: `immich-${id}`, pod: podSpec, vpn: config });

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

    exposeApp(this, {
      namespace: ns,
      serviceName: "immich",
      servicePort: 2283,
      hostname: `${namespaceName}.apps.local`,
    });
  }
}
