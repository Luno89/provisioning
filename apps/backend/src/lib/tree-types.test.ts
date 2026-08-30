import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import {
  TREE_TYPE_SEEDS, validateTreeType, resolveTreeType, renderStarterFiles, type TreeTypeSpec,
} from './tree-types.js';

const spec = (over: Partial<TreeTypeSpec> = {}): TreeTypeSpec => ({
  id: 'custom-thing',
  ownerId: 'u1',
  label: 'Custom thing',
  summary: 'Something this platform did not ship.',
  language: 'node',
  produces: 'artefact',
  doneMeans: 'It exists and it is right.',
  files: [],
  ...over,
});

describe('what a tree type must declare', () => {
  it('accepts a complete record', () => {
    expect(validateTreeType(IMAGES, spec())).toBeNull();
  });

  it('refuses one with no language, because the language decides the workspace image', () => {
    const { language: _dropped, ...rest } = spec();
    expect(validateTreeType(IMAGES, rest as TreeTypeSpec)).toMatch(/language/i);
  });

  it('refuses a language no workspace image exists for', () => {
    expect(validateTreeType(IMAGES, spec({ language: 'cobol' as never }))).toMatch(/language/i);
  });

  it('refuses a produces value outside service and artefact', () => {
    expect(validateTreeType(IMAGES, spec({ produces: 'vibes' as never }))).toMatch(/produces/i);
  });

  it('refuses an id that would not survive a URL or a filename', () => {
    expect(validateTreeType(IMAGES, spec({ id: 'Not A Slug!' }))).toMatch(/id/i);
  });

  it('refuses a starter file with an absolute or escaping path', () => {
    expect(validateTreeType(IMAGES, spec({ files: [{ path: '/etc/passwd', content: 'x' }] }))).toMatch(/path/i);
    expect(validateTreeType(IMAGES, spec({ files: [{ path: '../outside.md', content: 'x' }] }))).toMatch(/path/i);
  });
});

describe('resolving a type for a tree', () => {
  it('finds an owner\'s own record', async () => {
    const db = new MemoryDB();
    await db.init();
    await db.saveTreeType(spec({ id: 'mine', ownerId: 'u1' }));

    expect((await resolveTreeType(db, 'u1', 'mine'))?.label).toBe('Custom thing');
  });

  it('does not hand one owner\'s type to another', async () => {
    const db = new MemoryDB();
    await db.init();
    await db.saveTreeType(spec({ id: 'theirs', ownerId: 'u2' }));

    expect(await resolveTreeType(db, 'u1', 'theirs')).toBeUndefined();
  });

  it('returns nothing for a type that does not exist, rather than guessing', async () => {
    const db = new MemoryDB();
    await db.init();
    expect(await resolveTreeType(db, 'u1', 'invented')).toBeUndefined();
  });
});

describe('the seeds', () => {
  it('are all valid records', () => {
    for (const seed of TREE_TYPE_SEEDS) {
      expect(validateTreeType(IMAGES, { ...seed, ownerId: 'u1' }), `seed ${seed.id}`).toBeNull();
    }
  });

  it('lets a prose type say so, rather than naming a toolchain it does not need', () => {
    const prose = TREE_TYPE_SEEDS.find((t) => t.id === 'research-paper')!;
    expect(prose.language).toBe('base');
  });
});

describe('rendering the starter files', () => {
  it('substitutes the values a fresh repository needs', () => {
    const [file] = renderStarterFiles(
      [{ path: 'package.json', content: '{"name":"{{projectName}}"}' }],
      { projectName: 'koala-request-abc', registryHost: 'reg:5000' },
    );
    expect(file!.content).toBe('{"name":"koala-request-abc"}');
  });

  it('substitutes every occurrence, not just the first', () => {
    const [file] = renderStarterFiles(
      [{ path: 'README.md', content: '# {{projectName}}\n\nRun {{projectName}}.' }],
      { projectName: 'thing', registryHost: '' },
    );
    expect(file!.content).toBe('# thing\n\nRun thing.');
  });

  it('leaves an unknown placeholder alone rather than emitting "undefined"', () => {
    const [file] = renderStarterFiles(
      [{ path: 'x', content: 'a {{nope}} b' }],
      { projectName: 'p', registryHost: 'r' },
    );
    expect(file!.content).toBe('a {{nope}} b');
  });

  it('renders the path too, so a type can name a file after the project', () => {
    const [file] = renderStarterFiles(
      [{ path: 'docs/{{projectName}}.md', content: '' }],
      { projectName: 'thing', registryHost: '' },
    );
    expect(file!.path).toBe('docs/thing.md');
  });
});
