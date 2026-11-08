import { describe, expect, it } from 'vitest';
import { alreadyThere, freeBytes, noRoomFor, sizeText } from './file-room.js';

describe('room for files', () => {
  it('takes what fits exactly, and what has no size given', () => {
    expect(noRoomFor(100, 100)).toBeUndefined();
    expect(noRoomFor(0, 0)).toBeUndefined();
    expect(noRoomFor(undefined, 0)).toBeUndefined();
  });

  it('refuses one byte more than is free, saying how much it needs and how much is free', () => {
    expect(noRoomFor(101, 100)).toEqual({ needed: 101, free: 100, why: 'This needs 101 bytes, and 100 bytes is free' });
    expect(noRoomFor(3 * 1024 ** 3, 1536 * 1024 ** 2)).toEqual({ needed: 3 * 1024 ** 3, free: 1536 * 1024 ** 2, why: 'This needs 3.0 GB, and 1.5 GB is free' });
  });

  it('counts the free space from the blocks the file system says are free to anyone', () => {
    expect(freeBytes({ bavail: 10, bsize: 4096 })).toBe(40960);
    expect(freeBytes({ bavail: 10n, bsize: 4096n })).toBe(40960);
  });

  it('says a size in bytes, KB, MB or GB', () => {
    expect([sizeText(1023), sizeText(1024), sizeText(1024 ** 2 - 1), sizeText(1024 ** 2), sizeText(1024 ** 3 - 1), sizeText(1024 ** 3)])
      .toEqual(['1023 bytes', '1.0 KB', '1024.0 KB', '1.0 MB', '1024.0 MB', '1.0 GB']);
  });

  it('names what is already there, one file or several', () => {
    expect(alreadyThere(['a.pdf'])).toBe('a.pdf is already there');
    expect(alreadyThere(['a.pdf', 'docs/b.png'])).toBe('2 files are already there: a.pdf, docs/b.png');
  });
});
