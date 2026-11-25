import { randomBytes } from "node:crypto";
import { Construct, Namespace, appDeployment, mariadb, type DeploymentSpecTemplateSpec, Service, Secret, PersistentVolumeClaim, type VpnConfig, defaultServiceType, exposeApp } from "../lib/native-app.js";

export interface NextcloudNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly dbRepo?: string;
  readonly dbTag?: string;
  readonly dbStorage?: string;
  readonly webStorage?: string;
  readonly serviceType?: string;
  readonly adminPassword?: string;
  readonly dbPassword?: string;
  readonly dbRootPassword?: string;
}

export const NEXTCLOUD_ADMIN = "admin";
export const NEXTCLOUD_TRUSTED_HOST = "nextcloud";

export class NextcloudNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: NextcloudNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "nextcloud-native";
    const webImage = `${config.webRepo || "library/nextcloud"}:${config.webTag || "30.0-apache"}`;
    const dbImage = `${config.dbRepo || "library/mariadb"}:${config.dbTag || "11.4"}`;
    const dbSize = config.dbStorage || "2Gi";
    const webSize = config.webStorage || "10Gi";
    const adminPassword = config.adminPassword || randomBytes(24).toString("hex");
    const dbPassword = config.dbPassword || randomBytes(24).toString("hex");
    const dbRootPassword = config.dbRootPassword || randomBytes(24).toString("hex");

    const serviceType = config.serviceType || defaultServiceType();

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const dbSecret = new Secret(this, "db-secret", {
      metadata: {
        name: "nextcloud-db-credentials",
        namespace: ns.metadata.name,
      },
      data: {
        "mysql-root-password": dbRootPassword,
        "mysql-password": dbPassword,
        "admin-password": adminPassword,
      },
    });

    const webPvc = new PersistentVolumeClaim(this, "web-pvc", {
      metadata: {
        name: "nextcloud-web-pvc",
        namespace: ns.metadata.name,
      },
      waitUntilBound: false,
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: webSize } },
      },
    });

    mariadb(this, { name: "nextcloud", id, namespace: ns.metadata.name, image: dbImage, storage: dbSize, secretName: dbSecret.metadata.name });

    const podSpec: DeploymentSpecTemplateSpec = {
      container: [
        {
          name: "nextcloud",
          image: webImage,
          env: [
            { name: "MYSQL_HOST", value: "nextcloud-db-svc" },
            { name: "MYSQL_USER", value: "nextcloud" },
            {
              name: "MYSQL_PASSWORD",
              valueFrom: {
                secretKeyRef: {
                  name: dbSecret.metadata.name,
                  key: "mysql-password",
                },
              },
            },
            { name: "MYSQL_DATABASE", value: "nextcloud" },
            { name: "NEXTCLOUD_ADMIN_USER", value: NEXTCLOUD_ADMIN },
            {
              name: "NEXTCLOUD_ADMIN_PASSWORD",
              valueFrom: {
                secretKeyRef: {
                  name: dbSecret.metadata.name,
                  key: "admin-password",
                },
              },
            },
            { name: "NEXTCLOUD_TRUSTED_DOMAINS", value: `${NEXTCLOUD_TRUSTED_HOST} localhost ${namespaceName}.apps.local` },
          ],
          port: [{ containerPort: 80 }],
          volumeMount: [{ name: "web-data", mountPath: "/var/www/html" }],
        },
      ],
      volume: [{ name: "web-data", persistentVolumeClaim: { claimName: webPvc.metadata.name } }],
    };

    appDeployment(this, "web-deployment", { name: "nextcloud", namespace: ns.metadata.name, label: `nextcloud-web-${id}`, pod: podSpec, vpn: config });

    new Service(this, "web-service", {
      metadata: {
        name: "nextcloud",
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: { app: `nextcloud-web-${id}` },
        port: [{ port: 80, targetPort: "80" }],
      },
    });

    exposeApp(this, {
      namespace: ns,
      serviceName: "nextcloud",
      servicePort: 80,
      hostname: `${namespaceName}.apps.local`,
    });
  }
}
