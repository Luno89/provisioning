import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnConfig, VpnService } from "../lib/vpn-service.js";

export interface NextcloudNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly dbRepo?: string;
  readonly dbTag?: string;
  readonly dbStorage?: string;
  readonly serviceType?: string;
}

export class NextcloudNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: NextcloudNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "nextcloud-native";
    const webImage = `${config.webRepo || "library/nextcloud"}:${config.webTag || "30.0-apache"}`;
    const dbImage = `${config.dbRepo || "library/mariadb"}:${config.dbTag || "11.4"}`;
    const dbSize = config.dbStorage || "2Gi";

    const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "NodePort" : "LoadBalancer");

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
        "mysql-root-password": Buffer.from("nextcloud_root_password").toString("base64"),
        "mysql-password": Buffer.from("nextcloud_secure_password").toString("base64"),
      },
    });

    const dbPvc = new PersistentVolumeClaim(this, "db-pvc", {
      metadata: {
        name: "nextcloud-db-pvc",
        namespace: ns.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: dbSize,
          },
        },
      },
      waitUntilBound: false,
    });

    // DB Deployment (MariaDB)
    new Deployment(this, "db-deployment", {
      metadata: {
        name: "nextcloud-db",
        namespace: ns.metadata.name,
        labels: { app: `nextcloud-db-${id}` },
      },
      spec: {
        replicas: "1",
        selector: {
          matchLabels: { app: `nextcloud-db-${id}` },
        },
        template: {
          metadata: {
            labels: { app: `nextcloud-db-${id}` },
          },
          spec: {
            container: [
              {
                name: "mariadb",
                image: dbImage,
                env: [
                  { name: "MYSQL_DATABASE", value: "nextcloud" },
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
                  {
                    name: "MYSQL_ROOT_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: dbSecret.metadata.name,
                        key: "mysql-root-password",
                      },
                    },
                  },
                ],
                port: [{ containerPort: 3306 }],
                volumeMount: [
                  {
                    name: "db-data",
                    mountPath: "/var/lib/mysql",
                  },
                ],
              },
            ],
            volume: [
              {
                name: "db-data",
                persistentVolumeClaim: {
                  claimName: dbPvc.metadata.name,
                },
              },
            ],
          },
        },
      },
    });

    new Service(this, "db-service", {
      metadata: {
        name: "nextcloud-db-svc",
        namespace: ns.metadata.name,
      },
      spec: {
        selector: { app: `nextcloud-db-${id}` },
        port: [{ port: 3306, targetPort: "3306" }],
      },
    });

    const podSpec: any = {
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
            { name: "NEXTCLOUD_ADMIN_USER", value: "admin" },
            { name: "NEXTCLOUD_ADMIN_PASSWORD", value: "admin_secure_password" },
          ],
          port: [{ containerPort: 80 }],
        },
      ],
    };

    VpnService.apply(this, ns.metadata.name, podSpec, config);

    // Nextcloud Web Deployment
    new Deployment(this, "web-deployment", {
      metadata: {
        name: "nextcloud",
        namespace: ns.metadata.name,
        labels: { app: `nextcloud-web-${id}` },
      },
      spec: {
        replicas: "1",
        selector: {
          matchLabels: { app: `nextcloud-web-${id}` },
        },
        template: {
          metadata: {
            labels: { app: `nextcloud-web-${id}` },
          },
          spec: podSpec,
        },
      },
    });

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
  }
}
