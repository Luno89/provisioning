import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { TREE_TYPE_SEEDS, validateTreeType, resolveTreeType, renderStarterFiles, seedTreeTypes, treeTypeChoices, treeTypesFor, type TreeTypeSpec, agentProblem, groveAgentOf } from './tree-types.js';

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

  it('names the agent that grows its trees, one of the person\'s own, or the grove agent when it names none', () => {
    expect(agentProblem(undefined, ['grove'])).toBeNull();
    expect(agentProblem('grove-paper', ['grove', 'grove-paper'])).toBeNull();
    expect(agentProblem('ghost', ['grove'])).toMatch(/"ghost".*not one of your agents/);
    expect(agentProblem('', ['grove'])).toMatch(/agent must name/);
    expect(groveAgentOf(undefined)).toBe('grove');
    expect(groveAgentOf({ agent: 'grove-paper' })).toBe('grove-paper');
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

describe('the types a person chooses from', () => {
  // A shipped type has no owner, which TreeTypeSpec cannot say — the seeds are Omit<..., 'ownerId'>.
  const shipped = { id: 'freeform', label: 'Freeform project', summary: "Doesn't fit the other types." } as TreeTypeSpec;
  const mine = { ...shipped, ownerId: 'u1', label: 'Mine', agent: 'grove-careful' };
  const theirs = { ...shipped, ownerId: 'u2', label: 'Theirs', agent: 'their-grove' };

  it('lets a person\'s own row shadow the shipped one at the same id, agent and all', () => {
    expect(treeTypeChoices([shipped, mine], 'u1')).toEqual([
      { id: 'freeform', label: 'Mine', summary: "Doesn't fit the other types.", agent: 'grove-careful' },
    ]);
  });

  it('keeps a shipped type nobody has edited', () => {
    expect(treeTypeChoices([shipped], 'u1')).toEqual([
      { id: 'freeform', label: 'Freeform project', summary: "Doesn't fit the other types." },
    ]);
  });

  it('does not hand one owner\'s edit to another', () => {
    expect(treeTypeChoices([shipped, theirs], 'u1').map((type) => type.label)).toEqual(['Freeform project']);
  });

  it('drops the shipped row from the rows themselves, not only from the choices', () => {
    expect(treeTypesFor([shipped, mine], 'u1')).toEqual([mine]);
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

  it('keeps a starter script runnable, and does not make everything else so', () => {
    const rendered = renderStarterFiles(
      [{ path: 'build.sh', content: 'echo {{projectName}}', executable: true }, { path: 'README.md', content: '# {{projectName}}' }],
      { projectName: 'thing', registryHost: '' },
    );

    expect(rendered.map((file) => file.executable)).toEqual([true, undefined]);
  });
});

describe('seeding the shipped types', () => {
  const paper = () => TREE_TYPE_SEEDS.find((type) => type.id === 'research-paper')!;
  const shippedPaper = async (db: MemoryDB) =>
    (await db.getTreeTypes()).find((type) => type.id === 'research-paper' && type.ownerId === undefined);

  it('writes them all into an empty store', async () => {
    const db = new MemoryDB();
    await db.init();

    expect(await seedTreeTypes(db)).toBe(TREE_TYPE_SEEDS.length);
    expect((await shippedPaper(db))?.agent).toBe('grove-paper');
  });

  it('brings a stored type up to date with its seed, so a new agent reaches installs that already have it', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);

    // An install from before the type named its grove agent.
    const { agent: _agent, ...stale } = paper();
    await db.saveTreeType(stale as TreeTypeSpec);
    expect(await shippedPaper(db)).not.toHaveProperty('agent');

    expect(await seedTreeTypes(db)).toBe(1);
    expect((await shippedPaper(db))?.agent).toBe('grove-paper');
  });

  it('writes nothing on a second run, so provenance does not move', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);

    expect(await seedTreeTypes(db)).toBe(0);
  });

  it("never writes over a person's own edit of a shipped type", async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);
    await db.saveTreeType({ ...paper(), ownerId: 'u1', label: 'Mine', agent: 'grove-careful' });

    expect(await seedTreeTypes(db)).toBe(0);

    const rows = (await db.getTreeTypes('u1')).filter((type) => type.id === 'research-paper');
    expect(rows.map((type) => `${type.label}:${type.agent}`).sort()).toEqual([
      'Mine:grove-careful',
      'Research paper:grove-paper',
    ]);
  });
});
