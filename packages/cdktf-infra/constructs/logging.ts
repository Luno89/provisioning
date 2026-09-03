import { Construct } from "constructs";
import path from "path";
import { fileURLToPath } from "url";
import { Release } from "../.gen/providers/helm/release/index.js";
import { NetworkPolicyV1 } from "../.gen/providers/kubernetes/network-policy-v1/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../../");
const WORKER_LOG_DIR = path.join(PROJECT_ROOT, "apps", "backend", "data", "logs", "workers");
const MANAGEMENT_CLUSTER_NAME = "provisioning-lunorica";

export const LOKI_VALUES = {
  deploymentMode: "SingleBinary",
  loki: {
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
  resultsCache: {
    allocatedMemory: 128,
  },
  chunksCache: {
    allocatedMemory: 256,
  },
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

    new Release(this, "promtail-release", {
      name: "promtail",
      repository: "https://grafana.github.io/helm-charts",
      chart: "promtail",
      namespace: "monitoring",
      timeout: 300,
      values: [
        JSON.stringify({
          ...PROMTAIL_VALUES,
          ...(scrapeHostWorkerLogs ? {
            extraVolumes: [
              { name: "provisioning-worker-logs", hostPath: { path: WORKER_LOG_DIR, type: "DirectoryOrCreate" } },
              { name: "systemd-journal", hostPath: { path: "/var/log/journal", type: "DirectoryOrCreate" } },
            ],
            extraVolumeMounts: [
              { name: "provisioning-worker-logs", mountPath: "/var/log/provisioning-workers", readOnly: true },
              { name: "systemd-journal", mountPath: "/var/log/journal", readOnly: true },
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
                  "- job_name: journal",
                  "  journal:",
                  "    path: /var/log/journal",
                  "    max_age: 24h",
                  "    labels:",
                  "      job: systemd-journal",
                  "  relabel_configs:",
                  "    - source_labels: ['__journal__systemd_unit']",
                  "      target_label: 'unit'",
                ].join("\n"),
              },
            },
          }),
        ] : []),
      ],
    });

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
