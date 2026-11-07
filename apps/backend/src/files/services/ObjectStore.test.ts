import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Client } from 'minio';
import { minioObjectStore, ObjectMissing, type MinioSettings } from './ObjectStore.js';

const SETTINGS: MinioSettings = { endPoint: 'luno-minio', port: 9000, useSSL: false, accessKey: 'k', secretKey: 's', bucket: 'koala' };

const clientWith = (bucketThere: boolean) => {
  const client = mock<Client>();
  client.bucketExists.mockResolvedValue(bucketThere);
  client.makeBucket.mockResolvedValue(undefined);
  return client;
};

const notFound = (code: string) => Object.assign(new Error(code), { code });

describe('the instance\'s MinIO as the store of stored files\' bytes', () => {
  it('makes its bucket the first time it is used, once, and keeps each file under files/<id> with its type', async () => {
    const client = clientWith(false);
    client.putObject.mockResolvedValue({ etag: 'e', versionId: null });
    const store = minioObjectStore(SETTINGS, client);
    const body = Readable.from([Buffer.from('x')]);
    await store.put('f1', body, 1, 'text/plain');
    await store.put('f2', Readable.from([Buffer.from('y')]), undefined, 'image/png');
    expect(client.makeBucket).toHaveBeenCalledTimes(1);
    expect(client.makeBucket).toHaveBeenCalledWith('koala');
    expect(client.putObject).toHaveBeenNthCalledWith(1, 'koala', 'files/f1', body, 1, { 'Content-Type': 'text/plain' });
    expect(client.putObject.mock.calls[1]?.slice(0, 2)).toEqual(['koala', 'files/f2']);
    expect(client.putObject.mock.calls[1]?.[3]).toBeUndefined();
  });

  it('does not make a bucket that is already there', async () => {
    const client = clientWith(true);
    client.statObject.mockResolvedValue({ size: 3, etag: 'e', lastModified: new Date(), metaData: {}, versionId: null });
    expect(await minioObjectStore(SETTINGS, client).stat('f1')).toEqual({ size: 3 });
    expect(client.makeBucket).not.toHaveBeenCalled();
    expect(client.statObject).toHaveBeenCalledWith('koala', 'files/f1');
  });

  it('asks again whether its bucket is there after asking failed, rather than remembering the failure', async () => {
    const client = mock<Client>();
    client.bucketExists.mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValue(true);
    client.removeObject.mockResolvedValue(undefined);
    const store = minioObjectStore(SETTINGS, client);
    await expect(store.remove('f1')).rejects.toThrow('ECONNREFUSED');
    await store.remove('f1');
    expect(client.bucketExists).toHaveBeenCalledTimes(2);
    expect(client.removeObject).toHaveBeenCalledWith('koala', 'files/f1');
  });

  it.each(['NotFound', 'NoSuchKey'])('takes MinIO\'s %s as the file missing: undefined from stat, ObjectMissing from get', async (code) => {
    const client = clientWith(true);
    client.statObject.mockRejectedValue(notFound(code));
    client.getObject.mockRejectedValue(notFound(code));
    const store = minioObjectStore(SETTINGS, client);
    expect(await store.stat('gone')).toBeUndefined();
    await expect(store.get('gone')).rejects.toBeInstanceOf(ObjectMissing);
  });

  it('passes on every other failure as it came', async () => {
    const client = clientWith(true);
    client.statObject.mockRejectedValue(notFound('AccessDenied'));
    client.getObject.mockRejectedValue(notFound('AccessDenied'));
    const store = minioObjectStore(SETTINGS, client);
    await expect(store.stat('f1')).rejects.toThrow('AccessDenied');
    await expect(store.get('f1')).rejects.toThrow('AccessDenied');
  });

  it('hands back the stream MinIO gives for a file', async () => {
    const client = clientWith(true);
    const stream = Readable.from([Buffer.from('bytes')]);
    client.getObject.mockResolvedValue(stream);
    expect(await minioObjectStore(SETTINGS, client).get('f1')).toBe(stream);
    expect(client.getObject).toHaveBeenCalledWith('koala', 'files/f1');
  });

  it('lists the ids of everything under files/, leaving out anything else in the bucket', async () => {
    const client = clientWith(true);
    client.listObjectsV2.mockReturnValue(Readable.from([{ name: 'files/a' }, { name: 'files/' }, { name: 'other/b' }, {}, { name: 'files/c' }]) as never);
    const ids: string[] = [];
    for await (const id of minioObjectStore(SETTINGS, client).ids()) ids.push(id);
    expect(ids).toEqual(['a', 'c']);
    expect(client.listObjectsV2).toHaveBeenCalledWith('koala', 'files/', true);
  });
});
