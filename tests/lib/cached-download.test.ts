import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedDownload } from './cached-download.js';
import { freshPlaces } from './fresh-places.js';

const freshDir = freshPlaces('cached-download-');

const slowWrite = (content: string, started: string[]) => async (to: string): Promise<void> => {
  started.push(to);
  await fs.writeFile(to, content.slice(0, 3));
  await new Promise((done) => setImmediate(done));
  await fs.appendFile(to, content.slice(3));
};

describe('a VM base image downloaded into the shared cache', () => {
  it('is fetched once when two VMs of one suite boot at the same moment, and both get the whole image', async () => {
    const target = join(freshDir(), 'base.img');
    const started: string[] = [];
    const download = slowWrite('the-whole-image', started);

    const [first, second] = await Promise.all([cachedDownload(target, download), cachedDownload(target, download)]);

    expect([first, second]).toEqual([target, target]);
    expect(readFileSync(target, 'utf8')).toBe('the-whole-image');
    expect(started).toHaveLength(1);
  });

  it('survives another process downloading into the same cache at once, neither clobbering the other', async () => {
    const dir = freshDir();
    const target = join(dir, 'base.img');
    const started: string[] = [];
    const otherProcess = slowWrite('the-whole-image', started);
    const otherFinished = (async () => {
      const partial = await new Promise<string>((done) => {
        void otherProcess(`${target}.downloading`).then(() => done(`${target}.downloading`));
      });
      await fs.rename(partial, target);
    })();

    const ours = cachedDownload(target, slowWrite('the-whole-image', started));
    await Promise.all([ours, otherFinished]);

    expect(readFileSync(target, 'utf8')).toBe('the-whole-image');
    expect(readdirSync(dir)).toEqual(['base.img']);
  });

  it('is not fetched again once it is in the cache', async () => {
    const target = join(freshDir(), 'base.img');
    const started: string[] = [];
    await cachedDownload(target, slowWrite('the-whole-image', started));
    await cachedDownload(target, slowWrite('the-whole-image', started));
    expect(started).toHaveLength(1);
  });
});
