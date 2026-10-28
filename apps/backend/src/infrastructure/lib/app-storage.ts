export const POOL_MINIO_STORAGE = '10Gi';

export function minioStorageFor(onPool: boolean, chosen?: string | undefined): string | undefined {
  return onPool ? POOL_MINIO_STORAGE : chosen || undefined;
}

export function specStorageFor(appType: string, onPool: boolean, chosen: { minioStorage?: string | undefined }): Record<string, string> | undefined {
  if (appType !== 'minio') return undefined;
  const size = minioStorageFor(onPool, chosen.minioStorage);
  return size ? { '/data': size } : undefined;
}
