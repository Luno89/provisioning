import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inventoryFileFor } from './release-files.js';

describe('where the inventory of a release is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-files-'));
  writeFileSync(join(dir, 'abc123.sbom.json'), '{}');

  it('names the file when one is kept for that image tag', () => {
    expect(inventoryFileFor(dir, 'abc123')).toBe(join(dir, 'abc123.sbom.json'));
  });

  it('names nothing for an image tag with no file', () => {
    expect(inventoryFileFor(dir, 'def456')).toBeUndefined();
  });

  it('refuses a tag that could climb out of the folder', () => {
    expect(inventoryFileFor(dir, '../abc123')).toBeUndefined();
    expect(inventoryFileFor(dir, '')).toBeUndefined();
  });
});
