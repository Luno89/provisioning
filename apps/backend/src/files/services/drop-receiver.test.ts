import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dropBody } from '../lib/drops.js';
import { withReceivedDrop } from './drop-receiver.js';

const inPieces = (body: Buffer, size: number) => Readable.from(Array.from({ length: Math.ceil(body.length / size) }, (_, index) => body.subarray(index * size, (index + 1) * size)));

describe('a drop received onto disk', () => {
  it('writes each file to a folder of its own as it arrives, bytes intact, and removes the folder once the work is done', async () => {
    const png = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 256));
    const sources: string[] = [];
    const read = await withReceivedDrop(inPieces(dropBody({ dir: 'public', message: 'Logo' }, [{ path: 'logo.png', bytes: png }, { path: 'notes.md', bytes: Buffer.from('# Notes\n') }]), 4096), async (drop) => {
      if (!drop.ok) return drop;
      sources.push(...drop.files.map((file) => file.source));
      return { ...drop, contents: await Promise.all(drop.files.map((file) => readFile(file.source))) };
    });
    expect(read).toMatchObject({ ok: true, settings: { dir: 'public', message: 'Logo' }, files: [{ path: 'public/logo.png', size: png.length }, { path: 'public/notes.md', size: 8 }] });
    expect((read as { contents: Buffer[] }).contents).toEqual([png, Buffer.from('# Notes\n')]);
    expect(sources.some((source) => existsSync(source))).toBe(false);
  });

  it('says why a drop is refused, reads the rest of it, and leaves nothing behind', async () => {
    let seen: string[] = [];
    const read = await withReceivedDrop(inPieces(dropBody({}, [{ path: 'a', bytes: Buffer.from('1') }, { path: '../b', bytes: Buffer.from('2') }, { path: 'c', bytes: Buffer.alloc(10_000) }]), 3), async (drop) => {
      seen = drop.ok ? drop.files.map((file) => file.source) : [];
      return drop;
    });
    expect(read).toEqual({ ok: false, why: '../b would land outside the repository' });
    expect(seen).toEqual([]);
  });
});
