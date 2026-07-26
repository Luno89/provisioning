import { Construct } from "constructs";
import path from "path";
import { fileURLToPath } from "url";
import { Release } from "../.gen/providers/helm/release/index.js";
import { NetworkPolicyV1 } from "../.gen/providers/kubernetes/network-policy-v1/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../../");
// worker-host.ts/worker-cluster.ts write here (see apps/backend/src/lib/worker-logger.ts) — only
// exists on the SAME machine as the management cluster's native k3s, which is exactly the one
// case (see MANAGEMENT_CLUSTER_NAME below) this gets mounted for.
const WORKER_LOG_DIR = path.join(PROJECT_ROOT, "apps", "backend", "data", "logs", "workers");
const MANAGEMENT_CLUSTER_NAME = "provisioning-lunorica";

// Exported so tests/lib/memory-budget.ts can `helm template` against the exact same values this
// construct actually deploys, instead of a hand-maintained duplicate that can silently drift —
// confirmed live that a first attempt at that duplicate already had (and masked) real bugs.
export const LOKI_VALUES = {
  deploymentMode: "SingleBinary",
  loki: {
    // Chart defaults to multi-tenant mode (auth_enabled: true), which rejects every
    // request without an X-Scope-OrgID header — confirmed live: both a direct query
    // against Loki and Grafana's own datasource proxy failed ("no org id" / "Authentication
    // to data source failed") until this was set. This is a single-tenant dev platform;
    // disabling auth_enabled is simpler and more correct than threading a fake org-id
    // header through both Promtail's push client and Grafana's datasource config.
    auth_enabled: false,
    commonConfig: {
      replication_factor: 1,
    },
    schemaConfig: {
      configs: [
        {
          from: "2024-04-01",
          store: "tsdb",
          object_store: "s3",
          schema: "v13",
          index: {
            prefix: "loki_index_",
            period: "24h",
          },
        },
      ],
    },
    ingester: {
      chunk_encoding: "snappy",
    },
    querier: {
      max_concurrent: 2,
    },
  },
  singleBinary: {
    replicas: 1,
    resources: {
      requests: { cpu: "250m", memory: "256Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
  },
  // Chart defaults size these two memcached-backed caches for production Loki
  // installations, not a self-contained dev cluster — confirmed live via `helm show
  // values loki`: chunksCache.allocatedMemory defaults to 8192 (MB), which the chart's
  // own resource-derivation formula (floor(1.2 * allocatedMemory), also confirmed in
  // that same values.yaml) turns into a ~9.8Gi memory *request* with no override, and
  // resultsCache.allocatedMemory defaults to 1024 → ~1.2Gi. Together those alone
  // exceeded every VM size tried while chasing an unrelated "Insufficient memory"
  // scheduling failure in tests/remote-host-integration.ts before this was traced to its
  // actual root cause — not a resource-pressure fluke, an unconstrained chart default
  // that affects every cluster this platform provisions, not just that test. Same
  // philosophy as singleBinary.resources above: real but modest values for a dev/small
  // cluster, not the chart's production-scale defaults.
  resultsCache: {
    allocatedMemory: 128,
  },
  chunksCache: {
    allocatedMemory: 256,
  },
  // Zero out every SimpleScalable/Distributed-mode component — the chart deploys them
  // regardless of deploymentMode unless explicitly zeroed (confirmed in the chart's own
  // single-binary-values.yaml preset).
  backend: { replicas: 0 },
  read: { replicas: 0 },
  write: { replicas: 0 },
  ingester: { replicas: 0 },
  querier: { replicas: 0 },
  queryFrontend: { replicas: 0 },
  queryScheduler: { replicas: 0 },
  distributor: { replicas: 0 },
  compactor: { replicas: 0 },
  indexGateway: { replicas: 0 },
  bloomCompactor: { replicas: 0 },
  bloomGateway: { replicas: 0 },
  minio: {
    enabled: true,
  },
  test: {
    enabled: false,
  },
};

export const PROMTAIL_VALUES = {
  resources: {
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "200m", memory: "128Mi" },
  },
};

/**
 * Loki + Promtail, installed once per cluster into the `monitoring` namespace (co-located with
 * Prometheus/Grafana) — every pod's stdout/stderr becomes queryable in Grafana Explore, no
 * per-app wiring needed (Promtail is a DaemonSet, tails every container's logs on every node
 * automatically).
 *
 * Loki's chart defaults to `deploymentMode: SimpleScalable`, which requires external object
 * storage — not appropriate for a self-contained per-cluster dev stack. Values below mirror the
 * chart's own officially-bundled `single-binary-values.yaml` preset (one Loki process handling
 * every component, backed by an embedded MinIO for S3-compatible chunk storage — the chart has
 * no plain-filesystem storage option, only s3/gcs/azure), confirmed live via
 * `helm template loki grafana/loki -f single-binary-values.yaml`, but with resource
 * requests/limits well below the preset's own production-sized defaults (2-3 CPU / 2-4Gi) —
 * this needs to comfortably coexist with everything else already running on the same dev box.
 */
export class LoggingStack extends Construct {
  constructor(scope: Construct, id: string, clusterName?: string) {
    super(scope, id);
    const scrapeHostWorkerLogs = clusterName === MANAGEMENT_CLUSTER_NAME;

    new Release(this, "loki-release", {
      name: "loki",
      repository: "https://grafana.github.io/helm-charts",
      chart: "loki",
      namespace: "monitoring",
      timeout: 300,
      values: [JSON.stringify(LOKI_VALUES)],
    });

    // Default `config.clients[0].url: http://loki-gateway/loki/api/v1/push` (confirmed via
    // `helm show values grafana/promtail`) already resolves correctly as long as Loki's release
    // is named "loki" in this same namespace — which it is, above — so no client config
    // override needed here.
    new Release(this, "promtail-release", {
      name: "promtail",
      repository: "https://grafana.github.io/helm-charts",
      chart: "promtail",
      namespace: "monitoring",
      timeout: 300,
      values: [
        JSON.stringify({
          ...PROMTAIL_VALUES,
          // worker-host.ts/worker-cluster.ts (see apps/backend/src/lib/worker-logger.ts) write
          // structured logs to files on the host, outside any pod — the chart's default
          // scrape_configs only discover container logs via the K8s API, so those files need
          // their own hostPath mount + scrape_config, added only on the management cluster
          // (WORKER_LOG_DIR only exists on the same machine as it).
          ...(scrapeHostWorkerLogs ? {
            extraVolumes: [
              { name: "provisioning-worker-logs", hostPath: { path: WORKER_LOG_DIR, type: "DirectoryOrCreate" } },
            ],
            extraVolumeMounts: [
              { name: "provisioning-worker-logs", mountPath: "/var/log/provisioning-workers", readOnly: true },
            ],
          } : {}),
        }),
        ...(scrapeHostWorkerLogs ? [
          JSON.stringify({
            config: {
              snippets: {
                extraScrapeConfigs: [
                  "- job_name: provisioning-host-workers",
                  "  static_configs:",
                  "    - targets: [localhost]",
                  "      labels:",
                  "        job: provisioning-host-workers",
                  "        __path__: /var/log/provisioning-workers/*.log",
                ].join("\n"),
              },
            },
          }),
        ] : []),
      ],
    });

    // Loki has no auth of its own (auth_enabled: false above) — safe today only because its
    // Service is ClusterIP with no Ingress route to it (Traefik never gets a rule for it, unlike
    // apps — see lib/app-ingress.ts). That's a topology fact, not a guarantee: if a future change
    // ever gives Loki a LoadBalancer Service or an Ingress (the exact pattern every app construct
    // already uses), this NetworkPolicy is the actual enforced backstop — confirmed live on this
    // cluster (k3s v1.36.2, no separate visible netpol-controller pod, but a real deny-all/allow
    // test against a throwaway pod proved ingress rules ARE enforced) that it blocks traffic
    // regardless of Service type or Ingress rules. `app.kubernetes.io/instance: loki` covers
    // every pod from the Loki release (single-binary, gateway, canary, caches) so intra-release
    // traffic (e.g. gateway -> single-binary) keeps working; only Grafana and Promtail are
    // allowed in from outside the release.
    new NetworkPolicyV1(this, "loki-netpol", {
      metadata: {
        name: "loki-restrict-ingress",
        namespace: "monitoring",
      },
      spec: {
        podSelector: {
          matchLabels: {
            "app.kubernetes.io/instance": "loki",
          },
        },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { "app.kubernetes.io/instance": "loki" } } },
              { podSelector: { matchLabels: { "app.kubernetes.io/name": "grafana" } } },
              { podSelector: { matchLabels: { "app.kubernetes.io/name": "promtail" } } },
            ],
          },
        ],
      },
    });
  }
}
