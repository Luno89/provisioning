import { describe, expect, it } from 'vitest';
import { parseDiff, sortedForRelease } from './file-changes.js';

const DIFF = [
  'diff --git a/addons/labels/models.py b/addons/labels/models.py',
  'index 1111111..2222222 100644',
  '--- a/addons/labels/models.py',
  '+++ b/addons/labels/models.py',
  '@@ -1,3 +1,4 @@',
  ' from odoo import models',
  '-x = 1',
  '+x = 2',
  '+y = 3',
  'diff --git a/addons/labels/new.xml b/addons/labels/new.xml',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/addons/labels/new.xml',
  '@@ -0,0 +1,2 @@',
  '+<odoo>',
  '+</odoo>',
  'diff --git a/old.md b/old.md',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '--- a heading that starts with dashes',
  'diff --git a/a.txt b/b.txt',
  'similarity index 90%',
  'rename from a.txt',
  'rename to b.txt',
  'diff --git a/logo.png b/logo.png',
  'index 5555555..6666666 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

describe('parseDiff', () => {
  const files = parseDiff(DIFF);

  it('gives one entry per file, in the diff\'s order', () => {
    expect(files.map((file) => file.path)).toEqual(['addons/labels/models.py', 'addons/labels/new.xml', 'old.md', 'b.txt', 'logo.png']);
  });

  it('counts the lines each file adds and removes, a removed line starting with dashes among them', () => {
    expect(files.map((file) => [file.status, file.added, file.removed])).toEqual([
      ['modified', 2, 1], ['added', 2, 0], ['deleted', 0, 1], ['renamed', 0, 0], ['modified', 0, 0],
    ]);
  });

  it('keeps where a renamed file came from, marks a binary one, and keeps each file\'s own patch', () => {
    expect(files[3]!.from).toBe('a.txt');
    expect(files[4]!.binary).toBe(true);
    expect(files[1]!.patch.split('\n')[0]).toBe('diff --git a/addons/labels/new.xml b/addons/labels/new.xml');
    expect(files[1]!.patch).not.toContain('old.md');
  });

  it('reads an empty diff as no files', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('sortedForRelease', () => {
  const files = parseDiff(DIFF);

  it('marks the files the app is built from and puts them first', () => {
    const sorted = sortedForRelease(files, ['addons/**', 'Dockerfile']);
    expect(sorted.map((file) => [file.path, file.inApp])).toEqual([
      ['addons/labels/models.py', true], ['addons/labels/new.xml', true], ['b.txt', false], ['logo.png', false], ['old.md', false],
    ]);
  });

  it('counts a file renamed out of the app as in it', () => {
    expect(sortedForRelease(files, ['a.txt']).find((file) => file.path === 'b.txt')!.inApp).toBe(true);
  });

  it('counts every file as the app\'s when the type does not say what the app is built from', () => {
    expect(sortedForRelease(files, undefined).every((file) => file.inApp)).toBe(true);
  });
});
