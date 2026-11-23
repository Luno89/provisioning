import { Construct, Namespace, appDeployment, type DeploymentSpecTemplateSpec, Service, PersistentVolumeClaim, type VpnConfig, createAppIngress, createAppProbe, defaultServiceType } from "../lib/native-app.js";

export interface HomeassistantNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly configStorage?: string;
  readonly serviceType?: string;
}

export class HomeassistantNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: HomeassistantNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "homeassistant-native";
    const webImage = `${config.webRepo || "ghcr.io/home-assistant/home-assistant"}:${config.webTag || "stable"}`;
    const configSize = config.configStorage || "2Gi";

    const serviceType = config.serviceType || defaultServiceType();

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

    const podSpec: DeploymentSpecTemplateSpec = {
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

    appDeployment(this, "homeassistant-deployment", { name: "homeassistant", namespace: ns.metadata.name, label: `homeassistant-${id}`, pod: podSpec, vpn: config });

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
