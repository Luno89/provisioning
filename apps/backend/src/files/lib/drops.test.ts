import { describe, expect, it } from 'vitest';
import { DropReader, MAX_DROP_LINE, dropBody, dropLine, dropMessage, type DropEvent } from './drops.js';

function readAll(body: Buffer, size = body.length): DropEvent[] {
  const reader = new DropReader();
  const events: DropEvent[] = [];
  for (let at = 0; at < body.length; at += size) events.push(...reader.push(body.subarray(at, at + size)));
  return [...events, ...reader.finish()];
}

function filesOf(events: DropEvent[]): { path: string; bytes: Buffer }[] {
  const files: { path: string; chunks: Buffer[] }[] = [];
  for (const event of events) {
    if (event.kind === 'file') files.push({ path: event.path, chunks: [] });
    if (event.kind === 'bytes') files.at(-1)!.chunks.push(Buffer.from(event.chunk));
  }
  return files.map((file) => ({ path: file.path, bytes: Buffer.concat(file.chunks) }));
}

describe('a drop of files onto a repository, read as it arrives', () => {
  const png = Buffer.from([0x89, 0x50, 0x0a, 0x00, 0xff, 0x0a]);
  const body = dropBody({ dir: 'src/', ref: 'story-1' }, [{ path: './app.ts', bytes: Buffer.from('x\n') }, { path: 'img/logo.png', bytes: png }, { path: 'empty', bytes: Buffer.alloc(0) }]);

  it('puts each file under the folder it was dropped on, bytes intact, however the stream is cut', () => {
    for (const size of [1, 2, 7, body.length]) {
      const events = readAll(body, size);
      expect(events[0]).toEqual({ kind: 'settings', settings: { dir: 'src/', ref: 'story-1', message: undefined, leafId: undefined } });
      expect(events.some((event) => event.kind === 'refused')).toBe(false);
      expect(filesOf(events)).toEqual([{ path: 'src/app.ts', bytes: Buffer.from('x\n') }, { path: 'src/img/logo.png', bytes: png }, { path: 'src/empty', bytes: Buffer.alloc(0) }]);
      expect(events.filter((event) => event.kind === 'fileEnd')).toHaveLength(3);
    }
  });

  it('refuses anything that would leave the repository, nothing at all, the same file twice, or a drop cut short', () => {
    const refusal = (sent: Buffer) => readAll(sent).find((event) => event.kind === 'refused');
    expect(refusal(dropBody({}, [{ path: '../etc/passwd', bytes: Buffer.from('x') }]))).toMatchObject({ kind: 'refused' });
    expect(refusal(dropBody({ dir: '../up' }, [{ path: 'a', bytes: Buffer.from('x') }]))).toMatchObject({ kind: 'refused' });
    expect(refusal(dropBody({}, [{ path: 'a\nb', bytes: Buffer.from('x') }]))).toMatchObject({ kind: 'refused' });
    expect(refusal(dropBody({}, []))).toEqual({ kind: 'refused', why: 'nothing was dropped' });
    expect(refusal(Buffer.alloc(0))).toEqual({ kind: 'refused', why: 'nothing was dropped' });
    expect(refusal(dropBody({}, [{ path: 'a', bytes: Buffer.from('x') }, { path: './a', bytes: Buffer.from('y') }]))).toEqual({ kind: 'refused', why: 'a was dropped twice' });
    expect(refusal(Buffer.concat([dropLine({}), dropLine({ path: 'a', size: 5 }), Buffer.from('ab')]))).toEqual({ kind: 'refused', why: 'the drop ended before all of a arrived' });
    expect(refusal(Buffer.concat([dropLine({}), dropLine({ path: 'a', size: -1 })]))).toEqual({ kind: 'refused', why: 'each dropped file needs a path and its size' });
    expect(refusal(Buffer.concat([dropLine({}), Buffer.from('not json\n')]))).toEqual({ kind: 'refused', why: 'the drop is not in the shape Koala reads' });
    expect(refusal(Buffer.alloc(MAX_DROP_LINE + 1, 0x61))).toEqual({ kind: 'refused', why: 'a line of the drop is too long to name a file' });
  });

  it('names the commit after what was dropped unless the person said something', () => {
    expect(dropMessage([{ path: 'a.ts' }])).toBe('Add a.ts');
    expect(dropMessage([{ path: 'a.ts' }, { path: 'b.ts' }])).toBe('Add 2 files');
    expect(dropMessage([{ path: 'a.ts' }], ' The logo ')).toBe('The logo');
  });
});
