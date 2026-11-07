import { describe, expect, it } from 'vitest';
import { archivedArtifact, archivedObject } from './files-archive.js';

describe('where an old file lands in its person\'s Archive', () => {
  it('keeps an object\'s key under the app and bucket it came from', () => {
    expect(archivedObject('koala-files', 'koala-files', 'projects/shop/a.pdf')).toEqual({ kind: 'file', path: 'Archive/koala-files/koala-files/projects/shop/a.pdf' });
    expect(archivedObject('store', 'koala-artifacts', 'run-1/shot.png')).toEqual({ kind: 'file', path: 'Archive/store/koala-artifacts/run-1/shot.png' });
  });

  it('turns an empty folder\'s marker into the folder, at the top and deeper down', () => {
    expect(archivedObject('m', 'koala-files', 'docs/empty/.keep')).toEqual({ kind: 'folder', path: 'Archive/m/koala-files/docs/empty' });
    expect(archivedObject('m', 'koala-files', '.keep')).toEqual({ kind: 'folder', path: 'Archive/m/koala-files' });
  });

  it('names the app minio when it has no name', () => {
    expect(archivedObject('  ', 'koala-files', 'a.txt')).toEqual({ kind: 'file', path: 'Archive/minio/koala-files/a.txt' });
  });

  it('skips a key that is only a folder, and one that would leave the Archive', () => {
    expect(archivedObject('m', 'koala-files', 'docs/')).toEqual({ kind: 'none' });
    expect(archivedObject('m', 'koala-files', '../../escape.txt')).toEqual({ kind: 'none' });
    expect(archivedObject('m', 'koala-files', 'bad\u0001name')).toEqual({ kind: 'none' });
  });

  it('puts an artifact kept in Mongo under its run, naming what has no run or name', () => {
    expect(archivedArtifact('run-9', 'report.html')).toBe('Archive/artifacts/run-9/report.html');
    expect(archivedArtifact('', '')).toBe('Archive/artifacts/no-run/artifact');
    expect(archivedArtifact('run-9', '../x')).toBeUndefined();
  });
});
