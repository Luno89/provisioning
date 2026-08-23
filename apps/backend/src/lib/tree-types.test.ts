import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import {
  TREE_TYPE_SEEDS, validateTreeType, resolveTreeType, renderStarterFiles, type TreeTypeSpec,
} from './tree-types.js';

/**
 * ── WHY TREE TYPES ARE RECORDS AND NOT A UNION ──
 *
 * `TREE_TYPES` was a constant table whose own comment argued for itself: "A registry rather than a
 * boolean or a set of `if (type === 'x')` predicates scattered around. This codebase already learned
 * that with cluster providers: adding one used to mean twenty greps."
 *
 * It was right, and it was not finished. Two of its fields — `language` and `produces` — were never
 * read by anything, so the decisions they describe were made three other places instead: on the
 * persona, in `templateFor`'s switch, and in a `producesCode` check. That is how a research tree
 * ended up with an image that has no git.
 *
 * A record makes adding a project type a form rather than a deploy, which is the whole point.
 */

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
    expect(validateTreeType(spec())).toBeNull();
  });

  it('refuses one with no language, because the language decides the workspace image', () => {
    /**
     * The field that was declared and never read. A `research-paper` type says `base`, which has no
     * git — and once every tree has a repository, a type that cannot say what it needs produces a
     * leaf that cannot clone. Four leaves died that way in four seconds.
     */
    const { language: _dropped, ...rest } = spec();
    expect(validateTreeType(rest as TreeTypeSpec)).toMatch(/language/i);
  });

  it('refuses a language no workspace image exists for', () => {
    expect(validateTreeType(spec({ language: 'cobol' as never }))).toMatch(/language/i);
  });

  it('refuses a produces value outside service and artefact', () => {
    // `produces` decides whether the work is verified with a test run or read as a document.
    expect(validateTreeType(spec({ produces: 'vibes' as never }))).toMatch(/produces/i);
  });

  it('refuses an id that would not survive a URL or a filename', () => {
    expect(validateTreeType(spec({ id: 'Not A Slug!' }))).toMatch(/id/i);
  });

  it('refuses a starter file with an absolute or escaping path', () => {
    // These become files written into a fresh repository; a path that escapes it is a write
    // somewhere nobody asked for.
    expect(validateTreeType(spec({ files: [{ path: '/etc/passwd', content: 'x' }] }))).toMatch(/path/i);
    expect(validateTreeType(spec({ files: [{ path: '../outside.md', content: 'x' }] }))).toMatch(/path/i);
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
    // Same ownership rule every other record in this platform follows.
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
    // A seed that cannot pass its own validator is a seed that will fail the moment someone edits it.
    for (const seed of TREE_TYPE_SEEDS) {
      expect(validateTreeType({ ...seed, ownerId: 'u1' }), `seed ${seed.id}`).toBeNull();
    }
  });

  it('lets a prose type say so, rather than naming a toolchain it does not need', () => {
    /**
     * This used to assert that no seed may use `base`, which froze a fudge: the seeds had been
     * changed to `node` because `base` has no git and every tree takes a checkout. That is a fact
     * about checkouts, not about project types — `capableImage` reads the image catalogue and
     * upgrades when the workspace needs something the declared image lacks.
     */
    const prose = TREE_TYPE_SEEDS.find((t) => t.id === 'research-paper')!;
    expect(prose.language).toBe('base');
  });
});

describe('rendering the starter files', () => {
  /**
   * ── WHY PLACEHOLDERS AND NOT FUNCTIONS ──
   * The old templates were functions — `NODE_PACKAGE(name)`, `nodeBaseImage(registryHost)` — which
   * is fine for a constant and impossible for a record. A type editable in the Lab has to be able to
   * say "the project's name goes here" as data.
   */
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
    /**
     * A record is editable, so an unknown placeholder is a typo someone will make. Writing the word
     * "undefined" into a Dockerfile is a broken build with nothing pointing at the cause; leaving
     * the token visible says what happened.
     */
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
