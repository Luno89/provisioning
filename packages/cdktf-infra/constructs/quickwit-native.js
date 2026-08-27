import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class QuickwitNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "quickwit";
        const image = `${config.webRepo || "quickwit/quickwit"}:${config.webTag || "latest"}`;
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const bucket = config.bucket || "koala-corpus";
        const s3Endpoint = config.s3Endpoint || "http://minio.minio.svc.cluster.local:9000";
        const memoryLimit = config.memoryLimit || "3Gi";
        const ns = new Namespace(this, "ns", { metadata: { name: namespaceName } });
        const secret = new Secret(this, "secret", {
            metadata: { name: "quickwit-secret", namespace: ns.metadata.name },
            // Plaintext — the provider base64-encodes `data` itself (see searxng-native.ts).
            data: {
                access_key: config.s3AccessKey || "koala",
                secret_key: config.s3SecretKey || "",
            },
            type: "Opaque",
        });
        const podSpec = {
            /**
             * The bucket has to exist before Quickwit looks for its metastore in it.
             *
             * Nothing else creates it: MinIO does not auto-create on first write, and Quickwit reports a
             * missing bucket the same way it reports bad credentials — "failed to list manifest file",
             * which sends you looking at the keys. Creating it here keeps the two coupled things in one
             * object instead of relying on a setup step having been run.
             *
             * `--ignore-existing` because this runs on every pod start, and the second one is normal.
             */
            initContainer: [
                {
                    name: "create-bucket",
                    image: "minio/mc:latest",
                    command: ["/bin/sh", "-c"],
                    args: [
                        `until mc alias set store "${s3Endpoint}" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"; do `
                            + `echo "waiting for object storage"; sleep 3; done; `
                            + `mc mb --ignore-existing "store/${bucket}"`,
                    ],
                    env: [
                        { name: "AWS_ACCESS_KEY_ID", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "access_key" } } },
                        { name: "AWS_SECRET_ACCESS_KEY", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "secret_key" } } },
                    ],
                },
            ],
            container: [
                {
                    name: "quickwit",
                    image,
                    // One process serving every role. Splitting indexer from searcher is what you do when
                    // they need to scale apart; here they share a corpus that one node can index.
                    args: ["run"],
                    env: [
                        { name: "QW_METASTORE_URI", value: `s3://${bucket}/metastore` },
                        { name: "QW_DEFAULT_INDEX_ROOT_URI", value: `s3://${bucket}/indexes` },
                        { name: "QW_S3_ENDPOINT", value: s3Endpoint },
                        // See the header: MinIO serves path-style, and the default is virtual-host style.
                        { name: "QW_S3_FORCE_PATH_STYLE_ACCESS", value: "true" },
                        // MinIO ignores the region but the AWS SDK refuses to sign without one.
                        { name: "AWS_REGION", value: "us-east-1" },
                        { name: "AWS_ACCESS_KEY_ID", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "access_key" } } },
                        { name: "AWS_SECRET_ACCESS_KEY", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "secret_key" } } },
                        // Binds every interface. The default is loopback, which in Kubernetes is a Service
                        // with a healthy pod behind it that never answers — the same trap as Crawl4AI.
                        { name: "QW_LISTEN_ADDRESS", value: "0.0.0.0" },
                    ],
                    port: [{ containerPort: 7280, name: "rest" }, { containerPort: 7281, name: "grpc" }],
                    resources: {
                        limits: { memory: memoryLimit, cpu: "2000m" },
                        requests: { memory: "512Mi", cpu: "200m" },
                    },
                    livenessProbe: {
                        httpGet: { path: "/health/livez", port: "7280" },
                        initialDelaySeconds: 15,
                        periodSeconds: 20,
                    },
                    readinessProbe: {
                        // Readiness is what knows whether the metastore in the bucket actually answered. A
                        // Quickwit that cannot reach MinIO stays live and serves nothing.
                        httpGet: { path: "/health/readyz", port: "7280" },
                        initialDelaySeconds: 10,
                        periodSeconds: 10,
                    },
                },
            ],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "quickwit-deployment", {
            metadata: { name: "quickwit", namespace: ns.metadata.name, labels: { app: `quickwit-${id}` } },
            spec: {
                replicas: "1",
                selector: { matchLabels: { app: `quickwit-${id}` } },
                template: { metadata: { labels: { app: `quickwit-${id}` } }, spec: podSpec },
            },
        });
        new Service(this, "quickwit-service", {
            metadata: { name: "quickwit", namespace: ns.metadata.name },
            spec: {
                type: serviceType,
                selector: { app: `quickwit-${id}` },
                port: [
                    { port: 7280, targetPort: "7280", name: "rest" },
                    { port: 7281, targetPort: "7281", name: "grpc" },
                ],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "quickwit",
            servicePort: 7280,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "quickwit",
            servicePort: 7280,
            path: "/health/livez",
        });
    }
}
