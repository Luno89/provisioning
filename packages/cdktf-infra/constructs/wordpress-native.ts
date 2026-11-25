import { Construct, Namespace, appDeployment, mariadb, type DeploymentSpecTemplateSpec, Service, Secret, type VpnConfig, defaultServiceType, exposeApp } from "../lib/native-app.js";

export interface WordPressNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly dbRepo?: string;
  readonly dbTag?: string;
  readonly dbStorage?: string;
  readonly serviceType?: string;
}

export class WordPressNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: WordPressNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "wordpress-native";
    const webImage = `${config.webRepo || "library/wordpress"}:${config.webTag || "6.7-apache"}`;
    const dbImage = `${config.dbRepo || "library/mariadb"}:${config.dbTag || "11.4"}`;
    const dbSize = config.dbStorage || "2Gi";

    const serviceType = config.serviceType || defaultServiceType();

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const dbSecret = new Secret(this, "db-secret", {
      metadata: {
        name: "wordpress-db-credentials",
        namespace: ns.metadata.name,
      },
      data: {
        "mysql-root-password": Buffer.from("wordpress_root_password").toString("base64"),
        "mysql-password": Buffer.from("wordpress_secure_password").toString("base64"),
      },
    });

    mariadb(this, { name: "wordpress", id, namespace: ns.metadata.name, image: dbImage, storage: dbSize, secretName: dbSecret.metadata.name });

    const podSpec: DeploymentSpecTemplateSpec = {
      container: [
        {
          name: "wordpress",
          image: webImage,
          env: [
            { name: "WORDPRESS_DB_HOST", value: "wordpress-db-svc" },
            { name: "WORDPRESS_DB_USER", value: "wordpress" },
            {
              name: "WORDPRESS_DB_PASSWORD",
              valueFrom: {
                secretKeyRef: {
                  name: dbSecret.metadata.name,
                  key: "mysql-password",
                },
              },
            },
            { name: "WORDPRESS_DB_NAME", value: "wordpress" },
          ],
          port: [{ containerPort: 80 }],
        },
      ],
    };

    appDeployment(this, "web-deployment", { name: "wordpress", namespace: ns.metadata.name, label: `wordpress-web-${id}`, pod: podSpec, vpn: config });

    new Service(this, "web-service", {
      metadata: {
        name: "wordpress",
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: { app: `wordpress-web-${id}` },
        port: [{ port: 80, targetPort: "80" }],
      },
    });

    exposeApp(this, {
      namespace: ns,
      serviceName: "wordpress",
      servicePort: 80,
      hostname: `${namespaceName}.apps.local`,
    });
  }
}
