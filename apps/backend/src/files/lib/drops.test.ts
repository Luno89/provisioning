import { describe, expect, it } from 'vitest';
import { dropMessage, readDrop } from './drops.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('a drop of files onto a repository', () => {
  it('puts each file under the folder it was dropped on, bytes intact', () => {
    const read = readDrop({ dir: 'src/', files: [{ path: './app.ts', content: b64('x') }, { path: 'img/logo.png', content: Buffer.from([0, 255]).toString('base64') }] });
    expect(read).toEqual({ ok: true, files: [{ path: 'src/app.ts', bytes: Buffer.from('x') }, { path: 'src/img/logo.png', bytes: Buffer.from([0, 255]) }] });
  });

  it('refuses anything that would leave the repository, nothing at all, or the same file twice', () => {
    expect(readDrop({ files: [{ path: '../etc/passwd', content: b64('x') }] })).toMatchObject({ ok: false });
    expect(readDrop({ dir: '../up', files: [{ path: 'a', content: b64('x') }] })).toMatchObject({ ok: false });
    expect(readDrop({ files: [] })).toEqual({ ok: false, why: 'nothing was dropped' });
    expect(readDrop({ files: [{ path: 'a', content: b64('x') }, { path: './a', content: b64('y') }] })).toEqual({ ok: false, why: 'a was dropped twice' });
  });

  it('names the commit after what was dropped unless the person said something', () => {
    expect(dropMessage([{ path: 'a.ts' }])).toBe('Add a.ts');
    expect(dropMessage([{ path: 'a.ts' }, { path: 'b.ts' }])).toBe('Add 2 files');
    expect(dropMessage([{ path: 'a.ts' }], ' The logo ')).toBe('The logo');
  });
});
