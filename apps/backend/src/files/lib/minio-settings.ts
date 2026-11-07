export interface MinioSettings {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export const MINIO_SETTINGS = ['MINIO_ENDPOINT', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'MINIO_BUCKET'] as const;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function minioSettingsFrom(env: Readonly<Record<string, string | undefined>>): MinioSettings {
  const missing = MINIO_SETTINGS.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`The instance's MinIO, where its files are kept, is not set up: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set; the instance chart sets them all`);
  const endpoint = env.MINIO_ENDPOINT!.trim();
  const at = endpoint.lastIndexOf(':');
  const host = at > 0 ? endpoint.slice(0, at) : '';
  const port = Number(endpoint.slice(at + 1));
  if (!host || !/^\d+$/.test(endpoint.slice(at + 1)) || !(port > 0 && port < 65536)) throw new Error(`MINIO_ENDPOINT is not a host and port: ${endpoint}`);
  const bucket = env.MINIO_BUCKET!.trim();
  if (!BUCKET.test(bucket)) throw new Error(`MINIO_BUCKET is not a bucket name MinIO takes: ${bucket}`);
  return { endPoint: host, port, useSSL: false, accessKey: env.MINIO_ROOT_USER!.trim(), secretKey: env.MINIO_ROOT_PASSWORD!, bucket };
}
