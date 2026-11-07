import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ObjectMissing, type ObjectStore } from '../services/ObjectStore.js';

const bytesOf = async (body: Readable): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as string));
  return Buffer.concat(parts);
};

const listed = async (store: ObjectStore): Promise<string[]> => {
  const ids: string[] = [];
  for await (const id of store.ids()) ids.push(id);
  return ids.sort();
};

export function objectStoreContract(make: () => Promise<ObjectStore>): void {
  describe('the bytes of stored files, kept by id', () => {
    it('gives back exactly the bytes put under an id, every byte value included, and says their size', async () => {
      const store = await make();
      const bytes = Buffer.from(Array.from({ length: 256 }, (_unused, n) => n));
      await store.put('a1', Readable.from([bytes]), bytes.length, 'application/octet-stream');
      expect(await bytesOf(await store.get('a1'))).toEqual(bytes);
      expect(await store.stat('a1')).toEqual({ size: 256 });
    });

    it('takes bytes whose size it was not told, and an empty file', async () => {
      const store = await make();
      await store.put('streamed', Readable.from([Buffer.from('one '), Buffer.from('two')]), undefined, 'text/plain');
      await store.put('empty', Readable.from([Buffer.alloc(0)]), 0, 'text/plain');
      expect((await bytesOf(await store.get('streamed'))).toString()).toBe('one two');
      expect(await store.stat('empty')).toEqual({ size: 0 });
    });

    it('replaces the bytes when the same id is put again', async () => {
      const store = await make();
      await store.put('a1', Readable.from([Buffer.from('first')]), 5, 'text/plain');
      await store.put('a1', Readable.from([Buffer.from('second')]), 6, 'text/plain');
      expect((await bytesOf(await store.get('a1'))).toString()).toBe('second');
    });

    it('says an id it does not hold is missing, and removing one twice changes nothing', async () => {
      const store = await make();
      await expect(store.get('never')).rejects.toBeInstanceOf(ObjectMissing);
      expect(await store.stat('never')).toBeUndefined();
      await store.put('a1', Readable.from([Buffer.from('x')]), 1, 'text/plain');
      await store.remove('a1');
      await store.remove('a1');
      expect(await store.stat('a1')).toBeUndefined();
      await expect(store.get('a1')).rejects.toBeInstanceOf(ObjectMissing);
    });

    it('lists every id it holds, and only those', async () => {
      const store = await make();
      expect(await listed(store)).toEqual([]);
      for (const id of ['b', 'a', 'c']) await store.put(id, Readable.from([Buffer.from(id)]), 1, 'text/plain');
      await store.remove('c');
      expect(await listed(store)).toEqual(['a', 'b']);
    });
  });
}
