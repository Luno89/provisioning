import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_RUN_BYTES } from '../lib/artifacts.js';
import { storedFilesTwin } from '../testing/stored-files-twin.js';
import { ArtifactService } from './ArtifactService.js';

const bytesOf = async (body: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
};

const setUp = (clock = { at: '2026-10-08T12:00:00.000Z' }) => {
  const twin = storedFilesTwin({ now: Date.parse(clock.at) });
  return { ...twin, artifacts: new ArtifactService({ files: twin.files, now: () => clock.at }) };
};

describe('keeping a run\'s failure artifacts', () => {
  it('keeps each as a file of the run on the instance\'s MinIO, typed by its name, gone two weeks on', async () => {
    const { artifacts, objects, records } = setUp();
    const kept = await artifacts.put('bo', 'run-1', [{ name: 'signs-in/test-failed-1.png', bytes: Buffer.from('png') }, { name: 'report.html', bytes: Buffer.from('<p>'), contentType: 'text/html' }]);
    expect(kept.dropped).toEqual([]);
    expect(kept.stored.map((artifact) => [artifact.name, artifact.contentType, artifact.size, artifact.runId, artifact.ownerId, artifact.expiresAt])).toEqual([
      ['signs-in/test-failed-1.png', 'image/png', 3, 'run-1', 'bo', '2026-10-22T12:00:00.000Z'],
      ['report.html', 'text/html', 3, 'run-1', 'bo', '2026-10-22T12:00:00.000Z'],
    ]);
    const record = await records.storedFileById(kept.stored[0]!.id);
    expect(record).toMatchObject({ scope: { kind: 'run', id: 'run-1' }, path: 'signs-in/test-failed-1.png', state: 'stored', expiresAt: '2026-10-22T12:00:00.000Z' });
    expect(objects.kept.get(kept.stored[0]!.id)?.bytes.toString()).toBe('png');
    const read = await artifacts.get('bo', kept.stored[0]!.id);
    expect(read?.artifact).toEqual(kept.stored[0]);
    expect((await bytesOf(read!.body)).toString()).toBe('png');
  });

  it('keeps a run under its budget, counting what it already holds, dropping what does not fit and saying so', async () => {
    const { artifacts } = setUp();
    const half = Buffer.alloc(MAX_RUN_BYTES / 2 + 1);
    const first = await artifacts.put('bo', 'run-1', [{ name: 'a.webm', bytes: half }]);
    const second = await artifacts.put('bo', 'run-1', [{ name: 'b.webm', bytes: half }, { name: 'c.png', bytes: Buffer.from('png') }]);
    expect(first.stored).toHaveLength(1);
    expect(second.stored.map((artifact) => artifact.name)).toEqual(['c.png']);
    expect(second.dropped).toEqual(['b.webm']);
  });

  it('replaces an artifact kept again under the same name in the same run', async () => {
    const { artifacts } = setUp();
    await artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('one') }]);
    const again = await artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('second') }]);
    expect((await artifacts.list('bo', 'run-1')).map((artifact) => [artifact.id, artifact.size])).toEqual([[again.stored[0]!.id, 6]]);
  });

  it('lists a run\'s artifacts for its owner only, and never hands one owner another\'s artifact', async () => {
    const { artifacts } = setUp();
    const kept = await artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect((await artifacts.list('bo', 'run-1')).map((artifact) => artifact.id)).toEqual([kept.stored[0]!.id]);
    expect(await artifacts.get('al', kept.stored[0]!.id)).toBeUndefined();
    expect(await artifacts.list('al', 'run-1')).toEqual([]);
  });

  it('hands over only a run\'s files as artifacts, never another file of the person\'s by its id', async () => {
    const { artifacts, files } = setUp();
    const theirs = await files.at('bo', { kind: 'person', id: 'bo' }).upload('notes.txt', Readable.from([Buffer.from('n')]), 1, 'text/plain', { replace: true });
    if (!theirs.ok) throw new Error(theirs.why);
    expect(await artifacts.get('bo', theirs.value.id)).toBeUndefined();
    expect(await artifacts.get('bo', 'never')).toBeUndefined();
  });

  it('removes a run\'s artifacts, bytes and all, and leaves another run\'s', async () => {
    const { artifacts, objects } = setUp();
    await artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }, { name: 'b.png', bytes: Buffer.from('y') }]);
    await artifacts.put('bo', 'run-2', [{ name: 'c.png', bytes: Buffer.from('z') }]);
    expect(await artifacts.removeRun('bo', 'run-1')).toBe(2);
    expect(await artifacts.list('bo', 'run-1')).toEqual([]);
    expect(objects.kept.size).toBe(1);
    expect(await artifacts.list('bo', 'run-2')).toHaveLength(1);
  });

  it('leaves its expired artifacts to the sweep, which removes them with their bytes', async () => {
    const clock = { now: Date.parse('2026-10-08T12:00:00.000Z') };
    const twin = storedFilesTwin(clock);
    const artifacts = new ArtifactService({ files: twin.files, now: () => new Date(clock.now).toISOString() });
    await artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    clock.now = Date.parse('2026-10-21T12:00:00.000Z');
    expect((await twin.activities.StoredFilesSweepActivity()).expired).toBe(0);
    clock.now = Date.parse('2026-10-23T12:00:00.000Z');
    expect((await twin.activities.StoredFilesSweepActivity()).expired).toBe(1);
    expect(await artifacts.list('bo', 'run-1')).toEqual([]);
    expect(twin.objects.kept.size).toBe(0);
  });

  it('stamps artifacts with the current time when it is given none', async () => {
    const { files } = storedFilesTwin({ now: Date.now() });
    const kept = await new ArtifactService({ files }).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect(Math.abs(Date.parse(kept.stored[0]!.expiresAt!) - Date.now() - 14 * 86_400_000)).toBeLessThan(60_000);
  });

  it('fails, saying which artifact, when the file cannot be kept', async () => {
    const { artifacts, files } = setUp();
    await files.at('bo', { kind: 'run', id: 'run-1' }).makeFolder('a.png');
    await expect(artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }])).rejects.toThrow('a.png of run run-1 could not be kept: a.png is a folder');
  });
});
