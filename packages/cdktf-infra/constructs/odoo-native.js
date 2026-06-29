import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { VpnService } from "../lib/vpn-service.js";
export class OdooNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "odoo-native";
        const odooImage = `${config.odooRepo || "library/odoo"}:${config.odooTag || "18.0"}`;
        const pgImage = `${config.pgRepo || "library/postgres"}:${config.pgTag || "16.4"}`;
        const dbSize = config.dbStorage || "2Gi";
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const pgSecret = new Secret(this, "pg-secret", {
            metadata: {
                name: "odoo-pg-credentials",
                namespace: ns.metadata.name,
            },
            data: {
                "postgres-password": Buffer.from("odoo_secure_password").toString("base64"),
            },
        });
        const pgPvc = new PersistentVolumeClaim(this, "pg-pvc", {
            metadata: {
                name: "odoo-pg-pvc",
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
        // PostgreSQL Deployment
        const pgDeployment = new Deployment(this, "pg-deployment", {
            metadata: {
                name: "odoo-db",
                namespace: ns.metadata.name,
                labels: { app: `odoo-db-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `odoo-db-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `odoo-db-${id}` },
                    },
                    spec: {
                        container: [
                            {
                                name: "postgres",
                                image: pgImage,
                                env: [
                                    { name: "POSTGRES_USER", value: "odoo" },
                                    {
                                        name: "POSTGRES_PASSWORD",
                                        valueFrom: {
                                            secretKeyRef: {
                                                name: pgSecret.metadata.name,
                                                key: "postgres-password",
                                            },
                                        },
                                    },
                                    { name: "POSTGRES_DB", value: "postgres" },
                                    { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                                ],
                                port: [{ containerPort: 5432 }],
                                volumeMount: [
                                    {
                                        name: "pg-data",
                                        mountPath: "/var/lib/postgresql",
                                    },
                                ],
                            },
                        ],
                        volume: [
                            {
                                name: "pg-data",
                                persistentVolumeClaim: {
                                    claimName: pgPvc.metadata.name,
                                },
                            },
                        ],
                    },
                },
            },
        });
        new Service(this, "pg-service", {
            metadata: {
                name: "db",
                namespace: ns.metadata.name,
            },
            spec: {
                selector: { app: `odoo-db-${id}` },
                port: [{ port: 5432, targetPort: "5432" }],
            },
        });
        const podSpec = {
            container: [
                {
                    name: "odoo",
                    image: odooImage,
                    imagePullPolicy: odooImage.includes('custom') ? "Never" : "IfNotPresent",
                    env: [
                        { name: "HOST", value: "db" },
                        { name: "USER", value: "odoo" },
                        {
                            name: "PASSWORD",
                            valueFrom: {
                                secretKeyRef: {
                                    name: pgSecret.metadata.name,
                                    key: "postgres-password",
                                },
                            },
                        },
                    ],
                    port: [{ containerPort: 8069 }],
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        // Odoo Deployment
        new Deployment(this, "odoo-deployment", {
            metadata: {
                name: "odoo",
                namespace: ns.metadata.name,
                labels: { app: `odoo-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `odoo-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `odoo-${id}` },
                    },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "odoo-service", {
            metadata: {
                name: "odoo",
                namespace: ns.metadata.name,
            },
            spec: {
                type: "LoadBalancer",
                selector: { app: `odoo-${id}` },
                port: [{ port: 8069, targetPort: "8069" }],
            },
            waitForLoadBalancer: false,
        });
    }
}
