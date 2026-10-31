import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePrivate } from './private-file.js';

const kubeconfig = (user: string) => `apiVersion: v1\nusers:\n- name: ${user}\n  user:\n    client-key-data: ${'k'.repeat(3000)}\n`;

describe('a file only its owner reads', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'private-file-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is written readable by its owner alone, even over one that was readable by everyone', async () => {
    const path = join(dir, 'kubeconfig');
    writeFileSync(path, 'old', { mode: 0o644 });
    await writePrivate(path, 'apiVersion: v1');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('apiVersion: v1');
  });

  it('is replaced whole, so a reader that opened it before still reads what it opened, and leaves nothing beside it', async () => {
    const path = join(dir, 'kubeconfig');
    await writePrivate(path, kubeconfig('before'));
    const fd = openSync(path, 'r');
    try {
      await writePrivate(path, kubeconfig('after'));
      const buffer = Buffer.alloc(8192);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      expect(buffer.subarray(0, read).toString('utf8')).toBe(kubeconfig('before'));
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, 'utf8')).toBe(kubeconfig('after'));
    expect(readdirSync(dir)).toEqual(['kubeconfig']);
  });

  it('never shows a reader an empty or partial file while it is rewritten over and over', async () => {
    const path = join(dir, 'kubeconfig');
    const versions = [kubeconfig('a'), kubeconfig('b')];
    await writePrivate(path, versions[0]!);
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 2000; i++) await writePrivate(path, versions[i % 2]!);
      writing = false;
    })();
    const seen = new Set<string>();
    const reader = async () => {
      while (writing) seen.add(await readFile(path, 'utf8'));
    };
    await Promise.all([writer, reader(), reader(), reader()]);
    expect([...seen].filter((content) => !versions.includes(content)).map((content) => content.length)).toEqual([]);
  });

  it('takes several writers at once, ending with one whole version and nothing left beside it', async () => {
    const path = join(dir, 'kubeconfig');
    const versions = Array.from({ length: 20 }, (_, i) => kubeconfig(`writer-${i}`));
    await Promise.all(versions.map((content) => writePrivate(path, content)));
    expect(versions).toContain(readFileSync(path, 'utf8'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['kubeconfig']);
  });
});
