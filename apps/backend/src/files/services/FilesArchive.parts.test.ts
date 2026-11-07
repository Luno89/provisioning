import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { storedFilesTwin } from '../testing/stored-files-twin.js';
import { archiveOldFiles, type OldArtifact } from './FilesArchive.js';
import type { OldBucketReader } from './ObjectStore.js';

const bucketsOf = (buckets: Record<string, Record<string, string>>): OldBucketReader => ({
  has: async (bucket) => bucket in buckets,
  async *keys(bucket) {
    for (const [key, text] of Object.entries(buckets[bucket] ?? {})) yield { key, size: Buffer.byteLength(text) };
  },
  get: async (bucket, key) => ({ body: Readable.from([Buffer.from(buckets[bucket]![key]!)]), contentType: key.endsWith('.png') ? 'image/png' : 'application/octet-stream' }),
});

const bytes = async (body: Readable): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts).toString();
};

describe('the one-time archive of what people kept before', () => {
  it('copies every old MinIO app\'s files and the artifacts kept in Mongo into each person\'s Archive, then forgets the Mongo copies', async () => {
    const twin = storedFilesTwin();
    let forgotten = 0;
    const artifacts: OldArtifact[] = [{ ownerId: 'bo', runId: 'run-1', name: 'shot.png', contentType: 'image/png', bytes: Buffer.from('png') }];
    const done = await archiveOldFiles({
      files: twin.files,
      servers: async () => [
        { ownerId: 'bo', appName: 'koala-files', reader: bucketsOf({ 'koala-files': { 'projects/shop/a.pdf': 'pdf', 'docs/empty/.keep': '', 'odd/': '' }, 'koala-artifacts': { 'run-0/b.png': 'old png' } }) },
        { ownerId: 'al', appName: 'store', reader: bucketsOf({ 'other-bucket': { 'x.txt': 'never' } }) },
      ],
      async *oldArtifacts() { yield* artifacts; },
      forgetOldArtifacts: async () => { forgotten += 1; return 1; },
    });
    expect(done).toEqual({ files: 2, folders: 1, artifacts: 1, skipped: 1 });
    expect(forgotten).toBe(1);
    const bo = twin.files.at('bo', { kind: 'person', id: 'bo' });
    const pdf = await bo.download('Archive/koala-files/koala-files/projects/shop/a.pdf');
    expect(pdf.ok && await bytes(pdf.value.body)).toBe('pdf');
    expect((await bo.list('Archive/koala-files/koala-files/docs')).ok).toBe(true);
    const shot = await bo.download('Archive/artifacts/run-1/shot.png');
    expect(shot.ok && [shot.value.record.contentType, await bytes(shot.value.body)]).toEqual(['image/png', 'png']);
    expect(await twin.files.at('al', { kind: 'person', id: 'al' }).list('')).toEqual({ ok: true, value: [] });
  });

  it('can run again after stopping part way, replacing what it had copied rather than doubling it', async () => {
    const twin = storedFilesTwin();
    const server = { ownerId: 'bo', appName: 'm', reader: bucketsOf({ 'koala-files': { 'a.txt': 'a' } }) };
    const deps = { files: twin.files, servers: async () => [server], async *oldArtifacts() { yield* []; }, forgetOldArtifacts: async () => 0 };
    await archiveOldFiles(deps);
    await archiveOldFiles(deps);
    const listed = await twin.files.at('bo', { kind: 'person', id: 'bo' }).list('Archive/m/koala-files');
    expect(listed.ok && listed.value.map((entry) => entry.name)).toEqual(['a.txt']);
    expect(twin.objects.kept.size).toBe(1);
  });

  it('stops, saying which file, when one cannot be kept, so the archive is tried again whole', async () => {
    const twin = storedFilesTwin();
    await twin.files.at('bo', { kind: 'person', id: 'bo' }).upload('Archive', Readable.from([Buffer.from('a file in the way')]), 17, 'text/plain', { replace: true });
    await expect(archiveOldFiles({
      files: twin.files,
      servers: async () => [{ ownerId: 'bo', appName: 'm', reader: bucketsOf({ 'koala-files': { 'a.txt': 'a' } }) }],
      async *oldArtifacts() { yield* []; },
      forgetOldArtifacts: async () => 0,
    })).rejects.toThrow('Archive/m/koala-files/a.txt could not be put in the Archive');
  });
});
