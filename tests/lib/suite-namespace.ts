import dotenv from 'dotenv';

export const DEV_TEMPORAL_ADDRESS = '127.0.0.1:7233';

export const suiteNamespaceSettings = (dev: string, namespace: string, caFile: string): Record<string, string> => ({
  ...dotenv.parse(dev),
  TEMPORAL_NAMESPACE: namespace,
  TEMPORAL_CONNECTION_ADDRESS: DEV_TEMPORAL_ADDRESS,
  TEMPORAL_TLS_CA: caFile,
});
