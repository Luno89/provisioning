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
