import type { Readable } from 'node:stream';
import { Client } from 'minio';
import type { MinioSettings } from '../lib/minio-settings.js';
import { idOfObjectKey, objectKey } from '../lib/stored-files.js';

export type { MinioSettings };

export interface ObjectStat {
  size: number;
}

export interface ObjectStore {
  put(id: string, body: Readable, size: number | undefined, contentType: string): Promise<void>;
  get(id: string): Promise<Readable>;
  stat(id: string): Promise<ObjectStat | undefined>;
  remove(id: string): Promise<void>;
  ids(): AsyncIterable<string>;
}

export class ObjectMissing extends Error {
  constructor(readonly id: string) {
    super(`the bytes of file ${id} are not in the instance's MinIO`);
  }
}

type MinioClient = Pick<Client, 'bucketExists' | 'makeBucket' | 'putObject' | 'getObject' | 'statObject' | 'removeObject' | 'listObjectsV2'>;

const missing = (err: unknown): boolean => {
  const code = (err as { code?: string }).code;
  return code === 'NotFound' || code === 'NoSuchKey';
};

export function minioObjectStore(settings: MinioSettings, client: MinioClient = new Client({
  endPoint: settings.endPoint, port: settings.port, useSSL: settings.useSSL, accessKey: settings.accessKey, secretKey: settings.secretKey,
})): ObjectStore {
  const { bucket } = settings;
  let ready: Promise<void> | undefined;
  const bucketReady = (): Promise<void> => {
    ready ??= (async () => {
      if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
    })().catch((err: unknown) => {
      ready = undefined;
      throw err;
    });
    return ready;
  };
  return {
    async put(id, body, size, contentType) {
      await bucketReady();
      await client.putObject(bucket, objectKey(id), body, size, { 'Content-Type': contentType });
    },
    async get(id) {
      await bucketReady();
      try {
        return await client.getObject(bucket, objectKey(id));
      } catch (err) {
        if (missing(err)) throw new ObjectMissing(id);
        throw err;
      }
    },
    async stat(id) {
      await bucketReady();
      try {
        const stat = await client.statObject(bucket, objectKey(id));
        return { size: stat.size };
      } catch (err) {
        if (missing(err)) return undefined;
        throw err;
      }
    },
    async remove(id) {
      await bucketReady();
      await client.removeObject(bucket, objectKey(id));
    },
    async *ids() {
      await bucketReady();
      const listed = client.listObjectsV2(bucket, 'files/', true) as AsyncIterable<{ name?: string }>;
      for await (const item of listed) {
        const id = item.name ? idOfObjectKey(item.name) : undefined;
        if (id) yield id;
      }
    },
  };
}

export interface OldBucketObject {
  key: string;
  size: number;
}

export interface OldBucketReader {
  has(bucket: string): Promise<boolean>;
  keys(bucket: string): AsyncIterable<OldBucketObject>;
  get(bucket: string, key: string): Promise<{ body: Readable; contentType: string }>;
}

export function minioBucketReader(settings: Omit<MinioSettings, 'bucket'>, client: Pick<Client, 'bucketExists' | 'listObjectsV2' | 'getObject' | 'statObject'> = new Client({
  endPoint: settings.endPoint, port: settings.port, useSSL: settings.useSSL, accessKey: settings.accessKey, secretKey: settings.secretKey,
})): OldBucketReader {
  return {
    has: (bucket) => client.bucketExists(bucket),
    async *keys(bucket) {
      const listed = client.listObjectsV2(bucket, '', true) as AsyncIterable<{ name?: string; size?: number }>;
      for await (const item of listed) if (item.name) yield { key: item.name, size: item.size ?? 0 };
    },
    async get(bucket, key) {
      const stat = await client.statObject(bucket, key);
      const metaData: Record<string, unknown> = (stat.metaData as Record<string, unknown> | undefined) ?? {};
      const contentType = Object.entries(metaData).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      return { body: await client.getObject(bucket, key), contentType: typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream' };
    },
  };
}
