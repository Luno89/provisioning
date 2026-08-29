import { describe, it, expect } from 'vitest';
import { conventionsOf, describeConventions, extensionVariants } from './tree-type-conventions.js';
import type { TreeTypeSpec } from './tree-types.js';

const apiService = {
  id: 'api-service', ownerId: 'u1', label: 'API / service', summary: 's',
  language: 'node', produces: 'service', doneMeans: 'tests pass',
  files: [
    { path: 'Dockerfile', content: '' },
    { path: 'package.json', content: '' },
    { path: 'src/server.js', content: '' },
    { path: 'test/server.test.js', content: '' },
  ],
} as TreeTypeSpec;

const migration = {
  id: 'migration', ownerId: 'u1', label: 'Migration', summary: 's',
  language: 'node', produces: 'artefact', doneMeans: 'suite still passes', files: [],
} as TreeTypeSpec;

const dataset = {
  id: 'dataset', ownerId: 'u1', label: 'Dataset', summary: 's',
  language: 'python', produces: 'artefact', doneMeans: 'rows exist',
  files: [{ path: 'src/build.py', content: '' }, { path: 'tests/test_build.py', content: '' }],
} as TreeTypeSpec;

describe('conventionsOf', () => {
  it('derives the source extension from the scaffold, not the language name', () => {
    expect(conventionsOf(apiService)?.sourceExts).toEqual(['.js']);
  });

  it('derives the directories the template actually uses', () => {
    expect(conventionsOf(apiService)?.dirs).toEqual(['src', 'test']);
  });

  it('ignores root-level config files when naming directories', () => {
    expect(conventionsOf(apiService)?.dirs).not.toContain('Dockerfile');
    expect(conventionsOf(apiService)?.dirs).not.toContain('package.json');
  });

  it('falls back to the language default when a type ships no scaffold', () => {
    expect(conventionsOf(migration)?.sourceExts).toEqual(['.js', '.mjs', '.cjs']);
  });

  it('handles python', () => {
    const c = conventionsOf(dataset);
    expect(c?.sourceExts).toEqual(['.py']);
    expect(c?.dirs).toEqual(['src', 'tests']);
  });

  it('is undefined for no tree type, so callers keep today behaviour', () => {
    expect(conventionsOf(undefined)).toBeUndefined();
  });
});

describe('extensionVariants', () => {
  it('offers the sibling extension that actually broke the leaf', () => {
    const c = conventionsOf(apiService)!;
    expect(extensionVariants('src/tools.ts', c)).toContain('src/tools.js');
  });

  it('does not offer the path it was given', () => {
    const c = conventionsOf(apiService)!;
    expect(extensionVariants('src/tools.ts', c)).not.toContain('src/tools.ts');
  });

  it('leaves a path that already matches the convention alone', () => {
    const c = conventionsOf(apiService)!;
    expect(extensionVariants('src/tools.js', c)).toEqual([]);
  });

  it('does not rewrite an extensionless file', () => {
    const c = conventionsOf(apiService)!;
    expect(extensionVariants('Dockerfile', c)).toEqual([]);
  });

  it('does not rewrite documentation or data a leaf was legitimately asked for', () => {
    const c = conventionsOf(apiService)!;
    expect(extensionVariants('NOTES.md', c)).toEqual([]);
    expect(extensionVariants('data/rows.csv', c)).toEqual([]);
  });

  it('keeps the directory, changing only the extension', () => {
    const c = conventionsOf(dataset)!;
    expect(extensionVariants('src/build.rb', c)).toEqual(['src/build.py']);
  });
});

describe('describeConventions', () => {
  it('says the language, the extension and the directories in one sentence', () => {
    const text = describeConventions(conventionsOf(apiService)!);
    expect(text).toContain('node');
    expect(text).toContain('.js');
    expect(text).toContain('src');
    expect(text).toContain('test');
  });

  it('is a single line, since it is composed into a system prompt beside doneMeans', () => {
    expect(describeConventions(conventionsOf(apiService)!)).not.toContain('\n');
  });

  it('omits directories it could not derive rather than inventing them', () => {
    expect(describeConventions(conventionsOf(migration)!)).not.toContain('undefined');
  });
});
