import { randomBytes } from "node:crypto";
import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { type VpnConfig, VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

/**
 * MinIO — S3-compatible object storage, and the thing that actually holds crawled pages.
 *
 * ── WHY PAGE TEXT LEFT THE DATABASE ──
 * Pages were documents in Mongo. That is the right shape for metadata and the wrong one for the
 * content: measured on a real crawl, a page averages 10,568 bytes, so the terabyte this is being
 * built for is roughly 95 million documents whose only purpose is to hold a blob nothing queries by
 * field. Object storage is what that is, and it is the same reason Quickwit keeps its indexes here
 * rather than on a node's disk — see constructs/quickwit-native.ts.
 *
 * ── SINGLE NODE, ON PURPOSE ──
 * MinIO's distributed mode wants four nodes minimum for erasure coding. On the management cluster
 * that would be four PVCs and four pods to protect data that is, by construction, re-derivable: a
 * corpus is a crawl, and a crawl can be run again. Durability here is the PVC's.
 *
 * ── THE CONSOLE PORT IS NOT THE API PORT ──
 * 9000 is the S3 API, 9001 is the web console. They are different servers in one process, and
 * pointing an S3 client at 9001 fails in a way that reads like a credentials problem rather than a
 * port problem. The Service exposes both; `corpus-backend.ts` uses 9000 only.
 */
export interface MinioNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly serviceType?: string;
  /** Generated per-deployment when absent. */
  readonly rootUser?: string;
  readonly rootPassword?: string;
  /**
   * The PVC. Deliberately large by default relative to other apps here — this is the store the
   * corpus lives in, and running out of it fails a crawl halfway rather than at the start.
   */
  readonly storage?: string;
  readonly memoryLimit?: string;
}

export class MinioNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: MinioNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "minio";
    const image = `${config.webRepo || "minio/minio"}:${config.webTag || "latest"}`;
    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
    const storage = config.storage || "100Gi";
    const memoryLimit = config.memoryLimit || "2Gi";

    const ns = new Namespace(this, "ns", { metadata: { name: namespaceName } });

    const rootUser = config.rootUser || "koala";
    // Long by default: this credential is never typed by a human, so there is no reason for it to
    // be short enough to be.
    const rootPassword = config.rootPassword || randomBytes(24).toString("hex");

    const secret = new Secret(this, "secret", {
      metadata: { name: "minio-secret", namespace: ns.metadata.name },
      // Plaintext — the provider base64-encodes `data` itself (see searxng-native.ts).
      data: { root_user: rootUser, root_password: rootPassword },
      type: "Opaque",
    });

    const pvc = new PersistentVolumeClaim(this, "data-pvc", {
      metadata: { name: "minio-data-pvc", namespace: ns.metadata.name },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage } },
      },
      waitUntilBound: false,
    });

    const podSpec: any = {
      container: [
        {
          name: "minio",
          image,
          // `server` needs the data path, and the console needs an explicit address or it picks a
          // random port on every restart — which makes the Service's 9001 target nothing.
          args: ["server", "/data", "--console-address", ":9001"],
          env: [
            { name: "MINIO_ROOT_USER", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "root_user" } } },
            { name: "MINIO_ROOT_PASSWORD", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "root_password" } } },
          ],
          port: [{ containerPort: 9000, name: "s3" }, { containerPort: 9001, name: "console" }],
          volumeMount: [{ name: "data", mountPath: "/data" }],
          resources: {
            limits: { memory: memoryLimit, cpu: "2000m" },
            requests: { memory: "256Mi", cpu: "100m" },
          },
          livenessProbe: {
            httpGet: { path: "/minio/health/live", port: "9000" },
            initialDelaySeconds: 10,
            periodSeconds: 20,
          },
          readinessProbe: {
            // `/ready` rather than `/live`: a MinIO that is up but has not finished scanning its
            // disk answers live and refuses writes, which arrives as a crawl failing to store.
            httpGet: { path: "/minio/health/ready", port: "9000" },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
        },
      ],
      volume: [{ name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } }],
    };

    VpnService.apply(this, ns.metadata.name, podSpec, config);

    new Deployment(this, "minio-deployment", {
      metadata: { name: "minio", namespace: ns.metadata.name, labels: { app: `minio-${id}` } },
      spec: {
        replicas: "1",
        // A PVC is ReadWriteOnce, so two pods cannot both mount it. Recreate rather than the
        // default rolling update, which would deadlock waiting for a new pod that cannot start
        // until the old one it is waiting on has gone.
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: `minio-${id}` } },
        template: { metadata: { labels: { app: `minio-${id}` } }, spec: podSpec },
      },
    });

    new Service(this, "minio-service", {
      metadata: { name: "minio", namespace: ns.metadata.name },
      spec: {
        type: serviceType,
        selector: { app: `minio-${id}` },
        port: [
          { port: 9000, targetPort: "9000", name: "s3" },
          { port: 9001, targetPort: "9001", name: "console" },
        ],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "minio",
      // The console, because the ingress is what a person opens. Clients use the Service on 9000.
      servicePort: 9001,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "minio",
      servicePort: 9000,
      path: "/minio/health/live",
    });
  }
}
