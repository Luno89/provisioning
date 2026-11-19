import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, inject, it } from 'vitest';
import { storedFilesTwin } from '../testing/stored-files-twin.js';
import { archiveOldFiles } from './FilesArchive.js';
import { minioBucketReader, minioClient } from './ObjectStore.js';

describe('archiving a real MinIO app\'s buckets', () => {
  it('reads every key of the old buckets, nested ones included, with the type each was stored with', async () => {
    const settings = inject('minio');
    const client = minioClient({ ...settings, useSSL: false });
    const bucket = 'koala-files';
    if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
    const project = `p-${randomUUID().slice(0, 8)}`;
    await client.putObject(bucket, `${project}/deep/a.json`, Buffer.from('{"a":1}'), 7, { 'Content-Type': 'application/json' });
    await client.putObject(bucket, `${project}/b.bin`, Buffer.from([0, 255, 1]), 3);
    const twin = storedFilesTwin();
    const done = await archiveOldFiles({
      files: twin.files,
      servers: async () => [{ ownerId: 'bo', appName: 'old', reader: minioBucketReader(client) }],
      async *oldArtifacts() { yield* []; },
      forgetOldArtifacts: async () => 0,
    });
    expect(done.files).toBeGreaterThanOrEqual(2);
    const bo = twin.files.at('bo', { kind: 'person', id: 'bo' });
    const json = await bo.download(`Archive/old/koala-files/${project}/deep/a.json`);
    expect(json.ok && json.value.record.contentType).toBe('application/json');
    const bin = await bo.download(`Archive/old/koala-files/${project}/b.bin`);
    const parts: Buffer[] = [];
    if (bin.ok) for await (const part of bin.value.body as Readable) parts.push(Buffer.from(part as Buffer));
    expect([...Buffer.concat(parts)]).toEqual([0, 255, 1]);
  });
});
