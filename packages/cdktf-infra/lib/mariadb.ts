import type { Construct } from "constructs";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { AppDeployment } from "./app-deployment.js";

export function mariadb(scope: Construct, app: { name: string; id: string; namespace: string; image: string; storage: string; secretName: string }): void {
  const label = `${app.name}-db-${app.id}`;
  const secretRef = (key: string) => ({ secretKeyRef: { name: app.secretName, key } });
  const dbPvc = new PersistentVolumeClaim(scope, "db-pvc", {
    metadata: { name: `${app.name}-db-pvc`, namespace: app.namespace },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: app.storage } } },
    waitUntilBound: false,
  });
  new AppDeployment(scope, "db-deployment", {
    waitForRollout: false,
    metadata: { name: `${app.name}-db`, namespace: app.namespace, labels: { app: label } },
    spec: {
      replicas: "1",
      selector: { matchLabels: { app: label } },
      template: {
        metadata: { labels: { app: label } },
        spec: {
          container: [{
            name: "mariadb",
            image: app.image,
            env: [
              { name: "MYSQL_DATABASE", value: app.name },
              { name: "MYSQL_USER", value: app.name },
              { name: "MYSQL_PASSWORD", valueFrom: secretRef("mysql-password") },
              { name: "MYSQL_ROOT_PASSWORD", valueFrom: secretRef("mysql-root-password") },
            ],
            port: [{ containerPort: 3306 }],
            volumeMount: [{ name: "db-data", mountPath: "/var/lib/mysql" }],
          }],
          volume: [{ name: "db-data", persistentVolumeClaim: { claimName: dbPvc.metadata.name } }],
        },
      },
    },
  });
  new Service(scope, "db-service", {
    metadata: { name: `${app.name}-db-svc`, namespace: app.namespace },
    spec: { selector: { app: label }, port: [{ port: 3306, targetPort: "3306" }] },
  });
}
