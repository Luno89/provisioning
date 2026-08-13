import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { type VpnConfig, VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

/**
 * Quickwit — full-text search that reads its indexes straight out of object storage.
 *
 * ── WHY THIS AND NOT THE OBVIOUS ALTERNATIVES ──
 * The corpus search this replaces loaded every page an owner had into Node and scanned them with
 * `String.indexOf`. That is fine at forty pages and impossible at the ninety-five million a
 * terabyte works out to.
 *
 * Elasticsearch would work and would mean nodes whose RAM and disk scale with the corpus. Quickwit
 * is stateless and keeps its splits in S3, so what grows is the bucket rather than the cluster —
 * Binance run a 100 PB log service on it at ~80% less CPU than the Elasticsearch it replaced.
 * That property, not raw speed, is why it is here: a tier that has to cover ALL of the corpus
 * cannot have per-byte RAM cost, which is exactly what rules Qdrant out of this role.
 *
 * ── IT IS NOT INDEPENDENT OF MINIO ──
 * The metastore and the indexes both live in the bucket, so this pod is useless without the
 * credentials and endpoint of the MinIO beside it. That coupling is why the four search services
 * are provisioned as a group (SEARCH_APP_TYPES in the backend's app-catalog.ts) rather than
 * offered individually — a Quickwit pointed at storage that is not there comes up healthy and
 * finds nothing, which reads like an empty corpus.
 *
 * ── PATH-STYLE ACCESS IS MANDATORY ──
 * S3 clients default to virtual-host style, `https://bucket.host/key`. MinIO serves
 * `https://host/bucket/key`, and the difference surfaces as DNS failures for a bucket-named host
 * rather than as a storage error.
 */
export interface QuickwitNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly serviceType?: string;
  /** S3 endpoint of the MinIO holding the indexes, e.g. `http://minio.minio.svc.cluster.local:9000`. */
  readonly s3Endpoint?: string;
  readonly s3AccessKey?: string;
  readonly s3SecretKey?: string;
  /** Bucket for both the metastore and the index splits. */
  readonly bucket?: string;
  readonly memoryLimit?: string;
}

export class QuickwitNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: QuickwitNativeConfig = {}) {
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

    const podSpec: any = {
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
