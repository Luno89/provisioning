import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { dropBody, dropLine } from '../lib/drops.js';
import type { StoredFileRecord } from '../lib/stored-files.js';
import { receiveStoredDrop } from './stored-drop.js';
import type { StoredOutcome, UploadBatch } from './StoredFiles.js';

const AT = '2026-11-07T10:00:00.000Z';

const record = (path: string): StoredFileRecord => ({
  id: `id-${path}`, objectId: `id-${path}`, ownerId: 'u1', scope: { kind: 'project', id: 'p1' }, path, kind: 'file', size: 1, contentType: 'text/plain', version: 1,
  madeAt: AT, changedAt: AT, state: 'stored', touchedAt: AT,
});

const drained = async (body: Readable): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts).toString();
};

const inPieces = (body: Buffer, size = 3): Readable => Readable.from(Array.from({ length: Math.ceil(body.length / size) }, (_unused, n) => body.subarray(n * size, (n + 1) * size)));

const setUp = (there: readonly string[] = []) => {
  const batch = mock<UploadBatch>();
  const sent = new Map<string, { bytes: string; size: number | undefined; type: string }>();
  const replacing: boolean[] = [];
  Object.defineProperty(batch, 'replace', { get: () => replacing[0] ?? false });
  batch.check.mockImplementation((path) => (path.endsWith('/folder')
    ? { ok: false, status: 409, why: `${path} is a folder` }
    : { ok: true, value: { path, taken: there.includes(path) } }));
  batch.add.mockImplementation(async (path, body, size, type) => {
    sent.set(path, { bytes: await drained(body), size, type });
    return { ok: true, value: record(path) };
  });
  batch.keep.mockImplementation(async () => ({ ok: true, value: [...sent.keys()].map(record) }));
  const open = async (replace: boolean): Promise<UploadBatch> => {
    replacing.push(replace);
    return batch;
  };
  return { batch, sent, replacing, open, placed: (path: string) => `chats/c1/${path}` };
};

describe('a drop of files kept as stored files', () => {
  it('streams every file into the batch where it is placed, with its own type or one judged from its name, and keeps them in one commit', async () => {
    const { batch, sent, replacing, open, placed } = setUp();
    const body = dropBody({ dir: 'docs' }, [
      { path: 'a.pdf', bytes: Buffer.from('%PDF-1'), type: 'application/pdf' },
      { path: 'b/c.png', bytes: Buffer.from('png') },
      { path: 'empty.txt', bytes: Buffer.alloc(0) },
    ]);
    const kept = await receiveStoredDrop(inPieces(body), open, placed);
    expect(kept).toEqual({ ok: true, value: [record('chats/c1/docs/a.pdf'), record('chats/c1/docs/b/c.png'), record('chats/c1/docs/empty.txt')] });
    expect(replacing).toEqual([false]);
    expect(Object.fromEntries(sent)).toEqual({
      'chats/c1/docs/a.pdf': { bytes: '%PDF-1', size: 6, type: 'application/pdf' },
      'chats/c1/docs/b/c.png': { bytes: 'png', size: 3, type: 'image/png' },
      'chats/c1/docs/empty.txt': { bytes: '', size: 0, type: 'text/plain' },
    });
    expect(batch.keep).toHaveBeenCalledOnce();
    expect(batch.abandon).not.toHaveBeenCalled();
  });

  it('opens the batch to replace only when the drop says so', async () => {
    const { replacing, open, placed } = setUp(['chats/c1/a']);
    expect((await receiveStoredDrop(Readable.from([dropBody({ replace: true }, [{ path: 'a', bytes: Buffer.from('x') }])]), open, placed)).ok).toBe(true);
    expect(replacing).toEqual([true]);
  });

  it('names every file that is already there when it may not replace, storing none past the first and keeping nothing', async () => {
    const { batch, sent, open, placed } = setUp(['chats/c1/b', 'chats/c1/d']);
    const body = dropBody({}, ['a', 'b', 'c', 'd'].map((path) => ({ path, bytes: Buffer.from(path) })));
    expect(await receiveStoredDrop(Readable.from([body]), open, placed)).toEqual({ ok: false, status: 409, why: '2 files are already there: chats/c1/b, chats/c1/d', exists: ['chats/c1/b', 'chats/c1/d'] });
    expect([...sent.keys()]).toEqual(['chats/c1/a']);
    expect(batch.keep).not.toHaveBeenCalled();
    expect(batch.abandon).toHaveBeenCalledOnce();
  });

  it('refuses a path the batch refuses, keeping nothing', async () => {
    const { batch, open, placed } = setUp();
    const body = dropBody({}, [{ path: 'a', bytes: Buffer.from('a') }, { path: 'folder', bytes: Buffer.from('b') }, { path: 'c', bytes: Buffer.from('c') }]);
    expect(await receiveStoredDrop(Readable.from([body]), open, placed)).toEqual({ ok: false, status: 409, why: 'chats/c1/folder is a folder' });
    expect(batch.add).toHaveBeenCalledOnce();
    expect(batch.keep).not.toHaveBeenCalled();
    expect(batch.abandon).toHaveBeenCalledOnce();
  });

  it('passes on a file the batch will not take before reading it, whether or not its bytes fill the stream, and keeps nothing', async () => {
    for (const size of [4, 64 * 1024]) {
      const { batch, open, placed } = setUp();
      const refusal: StoredOutcome<StoredFileRecord> = { ok: false, status: 507, why: 'no room', needed: size, free: 1 };
      batch.add.mockResolvedValueOnce(refusal);
      const body = dropBody({}, [{ path: 'big', bytes: Buffer.alloc(size, 0x61) }, { path: 'after', bytes: Buffer.from('x') }]);
      expect(await receiveStoredDrop(inPieces(body, 1024), open, placed)).toEqual(refusal);
      expect(batch.add).toHaveBeenCalledOnce();
      expect(batch.abandon).toHaveBeenCalledOnce();
      expect(batch.keep).not.toHaveBeenCalled();
    }
  });

  it('refuses a drop cut short part way through a file, ending that file\'s upload and keeping nothing', async () => {
    const { batch, open, placed } = setUp();
    let ended: unknown;
    batch.add.mockImplementation(async (path, body) => {
      try {
        await drained(body);
      } catch (err) {
        ended = err;
        throw err;
      }
      return { ok: true, value: record(path) };
    });
    const cut = Buffer.concat([dropLine({}), dropLine({ path: 'a', size: 10 }), Buffer.from('abc')]);
    expect(await receiveStoredDrop(Readable.from([cut]), open, placed)).toEqual({ ok: false, status: 400, why: 'the drop ended before all of a arrived' });
    expect(ended).toBeInstanceOf(Error);
    expect(batch.abandon).toHaveBeenCalledOnce();
  });

  it('opens no batch for a drop refused in its first line', async () => {
    const { batch, replacing, open, placed } = setUp();
    expect(await receiveStoredDrop(Readable.from([dropBody({ dir: '../up' }, [{ path: 'a', bytes: Buffer.from('a') }])]), open, placed)).toMatchObject({ ok: false, status: 400 });
    expect(replacing).toEqual([]);
    expect(batch.abandon).not.toHaveBeenCalled();
  });

  it('throws when the body fails, ending the file that was arriving and keeping nothing', async () => {
    const { batch, open, placed } = setUp();
    let ended = false;
    batch.add.mockImplementation(async (path, body) => {
      await drained(body).catch(() => { ended = true; });
      return { ok: true, value: record(path) };
    });
    async function* failing(): AsyncGenerator<Buffer> {
      yield Buffer.concat([dropLine({}), dropLine({ path: 'a', size: 10 }), Buffer.from('abc')]);
      throw new Error('the connection was lost');
    }
    await expect(receiveStoredDrop(failing(), open, placed)).rejects.toThrow('the connection was lost');
    expect(ended).toBe(true);
    expect(batch.keep).not.toHaveBeenCalled();
  });
});
