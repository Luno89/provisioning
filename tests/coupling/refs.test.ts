import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('finding references across workspaces linked by a symlink, as npm links them', () => {
  const root = mkdtempSync(join(tmpdir(), 'refs-workspace-'));
  cpSync(join(import.meta.dirname, 'fixture-refs-workspace'), root, { recursive: true });
  mkdirSync(join(root, 'apps/app/node_modules/@fixture'), { recursive: true });
  symlinkSync('../../../../packages/lib', join(root, 'apps/app/node_modules/@fixture/lib'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds an app\'s use of a package\'s function through the link and the package\'s export *', () => {
    const found = referencesOf(root, ['apps/app/tsconfig.json'], 'packages/lib/src/tool.ts', 'tool').map(({ file, line, kind }) => `${file}:${line} ${kind}`);
    expect(found).toEqual(['apps/app/src/use.ts:1 import', 'apps/app/src/use.ts:3 read', 'packages/lib/src/tool.ts:1 declaration']);
  });
});
