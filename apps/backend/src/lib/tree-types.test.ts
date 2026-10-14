import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { dependencyNamespaceFrom, treeExtrasFrom, treeTypeOfProject, TREE_TYPE_SEEDS, validateTreeType, resolveTreeType, renderStarterFiles, seedTreeTypes, treeTypeChoices, treeTypesFor, type TreeTypeSpec, agentProblem, groveAgentOf, treeLanguage, treeVersion, versionForNewTree, stampTreeVersions, versionVars } from './tree-types.js';

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

describe('the secrets a type declares', () => {
  const secrets = (list: unknown) => validateTreeType(IMAGES, spec({ secrets: list as TreeTypeSpec['secrets'] }));

  it('takes environment variable names, each from a source it knows, said what it is for, at most once', () => {
    expect(secrets([{ key: 'ODOO_ADMIN_PASSWORD', source: 'generated', describe: 'The admin password.', signInAs: 'admin' }, { key: 'STRIPE_KEY', source: 'person', describe: 'From the Stripe dashboard.' }])).toBeNull();
    expect(secrets([{ key: 'admin password', source: 'generated', describe: 'x' }])).toMatch(/not an environment variable name/);
    expect(secrets([{ key: 'A', source: 'magic', describe: 'x' }])).toBe('A must come from one of generated, gitea-read-token, person.');
    expect(secrets([{ key: 'A', source: 'generated', describe: '' }])).toMatch(/^A: say what the secret is for/);
    expect(secrets([{ key: 'A', source: 'generated', describe: 'x' }, { key: 'A', source: 'person', describe: 'y' }])).toBe('A is declared twice.');
    expect(secrets([{ key: 'A', source: 'generated', describe: 'x', signInAs: ' ' }])).toBe('A: signInAs names the login this password signs in as.');
    expect(secrets('A')).toBe('secrets must be a list of {key, source, describe}.');
  });

  it('gives the Odoo type a database and an admin password the platform makes, the admin\'s to sign in with', () => {
    expect(TREE_TYPE_SEEDS.find((type) => type.id === 'odoo-addons')?.secrets).toEqual([
      expect.objectContaining({ key: 'POSTGRES_PASSWORD', source: 'generated' }),
      expect.objectContaining({ key: 'ODOO_ADMIN_PASSWORD', source: 'generated', signInAs: 'admin' }),
    ]);
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

describe('what a tree\'s type adds to its workspaces', () => {
  const store = (type: Partial<TreeTypeSpec>) => ({
    getTrees: async () => [{ id: 't1', ownerId: 'u1', type: 'custom-thing' }],
    getTreeTypes: async () => [spec(type)],
  });

  it('gives every leaf the type\'s plain values, its own network rules, and a way to the services the app depends on', async () => {
    const extras = await treeExtrasFrom(store({
      env: [{ name: 'SHOP_CURRENCY', value: 'EUR' }],
      egress: [{ cidr: '10.1.0.0/16', ports: [5432] }, { namespace: 'mail' }, {} as never],
      defaultBindings: ['shop-db', 'missing'],
    }), async (_owner, service) => (service === 'shop-db' ? 'shop-db-1a2b3c' : undefined))('u1', 't1');
    expect(extras).toEqual({
      env: [{ name: 'SHOP_CURRENCY', value: 'EUR' }],
      egress: [{ cidr: '10.1.0.0/16', ports: [5432] }, { namespace: 'mail' }, { namespace: 'shop-db-1a2b3c' }],
    });
  });

  it('adds nothing for a tree whose type is gone', async () => {
    expect(await treeExtrasFrom({ getTrees: async () => [], getTreeTypes: async () => [] }, async () => undefined)('u1', 't1')).toBeUndefined();
  });

  it('finds a service the app depends on among the person\'s own apps, by name, in the namespace it runs in', async () => {
    const find = dependencyNamespaceFrom({ getDeployments: async () => [
      { ownerId: 'u1', name: 'Shop DB', namespace: 'shop-db-1a2b3c' },
      { ownerId: 'u1', name: 'cache' },
      { ownerId: 'u2', name: 'mine-not' },
    ] });
    expect(await find('u1', 'shop-db')).toBe('shop-db-1a2b3c');
    expect(await find('u1', 'cache')).toBe('cache');
    expect(await find('u1', 'mine-not')).toBeUndefined();
  });
});

describe('the type a project is built as', () => {
  it('is the type of the tree it is the home of, and nothing for a project no tree is the home of', async () => {
    const store = { getTrees: async () => [{ id: 't1', ownerId: 'u1', type: 'custom-thing', projectIds: ['p1', 'p2'] }], getTreeTypes: async () => [spec({ releaseWhen: ['src/**'] })] };
    expect((await treeTypeOfProject(store, { id: 'p1', ownerId: 'u1' }))?.releaseWhen).toEqual(['src/**']);
    expect(await treeTypeOfProject(store, { id: 'p2', ownerId: 'u1' })).toBeUndefined();
    expect(await treeTypeOfProject(store, { id: 'p1', ownerId: 'u2' })).toBeUndefined();
  });
});

describe('a tree type with versions', () => {
  const odoo = { ...TREE_TYPE_SEEDS.find((type) => type.id === 'odoo-addons')!, ownerId: 'u1' };

  it('ships Odoo 20 as the default for new trees, with 18 still offered', () => {
    expect(odoo.versions).toMatchObject({ of: 'Odoo', choices: [{ version: '20', language: 'odoo-20' }, { version: '18', language: 'odoo' }], default: '20' });
    expect(validateTreeType(IMAGES, odoo)).toBeNull();
  });

  it('refuses versions that cannot be worked or have no default among them', () => {
    const versions = (over: object) => validateTreeType(IMAGES, spec({ versions: { of: 'Odoo', choices: [{ version: '20', language: 'odoo-20' }], default: '20', ...over } as never }));
    expect(versions({})).toBeNull();
    expect(versions({ choices: [{ version: '21', language: 'odoo-21' }], default: '21' })).toMatch(/Version 21 must work in one of/);
    expect(versions({ default: '18' })).toBe('The default version must be one of the choices.');
    expect(versions({ choices: [{ version: '20', language: 'odoo-20' }, { version: '20', language: 'odoo' }] })).toBe('Version 20 is listed twice.');
    expect(versions({ choices: [] })).toBe('versions needs at least one choice.');
  });

  it('works a tree in its version\'s workspace, and a tree from before versions in the type\'s own', () => {
    expect(treeLanguage(odoo, { version: '20' })).toBe('odoo-20');
    expect(treeLanguage(odoo, { version: '18' })).toBe('odoo');
    expect(treeLanguage(odoo, {})).toBe('odoo');
    expect(treeVersion(odoo, {})).toBe('18');
    expect(treeVersion(spec(), { version: '20' })).toBeUndefined();
  });

  it('gives a new tree the default, takes one it offers, and refuses one it does not', () => {
    expect(versionForNewTree(odoo, undefined)).toEqual({ ok: true, version: '20' });
    expect(versionForNewTree(odoo, '18')).toEqual({ ok: true, version: '18' });
    expect(versionForNewTree(odoo, '19')).toEqual({ ok: false, error: 'Odoo 19 is not offered; choose 20 or 18.' });
    expect(versionForNewTree(spec(), undefined)).toEqual({ ok: true });
    expect(versionForNewTree(spec(), '2')).toEqual({ ok: false, error: 'This type has no versions to choose from.' });
  });

  it('starts a tree from files written for its version, with what that version does its own way', () => {
    const starter = (version: string, path: string) => renderStarterFiles(odoo.files, { projectName: 'p', registryHost: '', ...versionVars(odoo, { version }) }).find((file) => file.path === path)?.content ?? '';
    expect(starter('20', 'Dockerfile')).toMatch(/^FROM odoo:20$/m);
    expect(starter('18', 'Dockerfile')).toMatch(/^FROM odoo:18$/m);
    expect(starter('20', 'addons/README.md')).toContain('security/ir.access.csv  access rules for any new model');
    expect(starter('20', 'addons/README.md')).toContain('## Odoo 20\n\nOdoo 20 changed things');
    expect(starter('20', 'addons/README.md')).toContain('`ir.model.access` and `ir.rule` no longer exist');
    expect(starter('18', 'addons/README.md')).toContain('security/ir.model.access.csv  access rules for any new model');
    expect(starter('18', 'addons/README.md')).not.toMatch(/\{\{\w+\}\}/);
    expect(versionVars(spec(), {})).toEqual({});
  });

  it('stamps the trees that predate versions with the one they already work in, and leaves the rest', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);
    const tree = (id: string, type: string, version?: string) => ({ id, ownerId: 'u1', name: id, type, ...(version ? { version } : {}), createdAt: 'a', updatedAt: 'a' });
    await db.saveTree(tree('old', 'odoo-addons'));
    await db.saveTree(tree('new', 'odoo-addons', '20'));
    await db.saveTree(tree('api', 'api-service'));

    expect(await stampTreeVersions(db as never)).toBe(1);
    const trees = await db.getTrees();
    expect(trees.map((entry) => [entry.id, entry.version, entry.updatedAt])).toEqual([['old', '18', 'a'], ['new', '20', 'a'], ['api', undefined, 'a']]);
    expect(await stampTreeVersions(db as never)).toBe(0);
  });

  it('lists the versions with the type, so the planner can choose', () => {
    expect(treeTypeChoices([odoo], 'u1')[0]?.versions).toEqual({ of: 'Odoo', choices: ['20', '18'], default: '20' });
  });
});
