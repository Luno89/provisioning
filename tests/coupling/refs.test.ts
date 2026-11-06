import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { referencesOf } from './refs.js';

const root = join(import.meta.dirname, 'fixture-refs');

describe('finding references through the type checker', () => {
  it('finds where a field is declared, written and read, and not a same-named field of another type', () => {
    const found = referencesOf(root, ['tsconfig.json'], 'src/secret.ts', 'Secret.source').map(({ file, line, kind }) => `${file}:${line} ${kind}`);
    expect(found).toEqual(['src/secret.ts:3 declaration', 'src/secret.ts:10 write', 'src/vault.ts:4 read', 'src/vault.ts:11 read']);
  });

  it('finds the same from a line and column in the file', () => {
    const found = referencesOf(root, ['tsconfig.json'], 'src/secret.ts', '3:3').map(({ file, line, kind }) => `${file}:${line} ${kind}`);
    expect(found).toEqual(['src/secret.ts:3 declaration', 'src/secret.ts:10 write', 'src/vault.ts:4 read', 'src/vault.ts:11 read']);
  });

  it('tells an import apart from a use', () => {
    const found = referencesOf(root, ['tsconfig.json'], 'src/secret.ts', 'Secret').map(({ file, line, kind }) => `${file}:${line} ${kind}`);
    expect(found).toEqual(['src/secret.ts:1 declaration', 'src/secret.ts:10 read', 'src/vault.ts:1 import', 'src/vault.ts:3 read']);
  });

  it('refuses a name the file does not declare, so a typo never answers with nothing', () => {
    expect(() => referencesOf(root, ['tsconfig.json'], 'src/secret.ts', 'Secret.nothing')).toThrow('no declaration of Secret.nothing in src/secret.ts');
  });
});
