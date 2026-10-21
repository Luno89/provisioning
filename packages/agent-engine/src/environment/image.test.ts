import { describe, it, expect } from 'vitest';
import { BASES, DEFAULT_BASE, UnbuildableError, baseFor, fingerprint, imageFor, imageReference, languagesFor, needsBuilding, planImage, renderDockerfile, proofScript } from './image.js';
import type { ToolDefinition } from '../tools/catalogue.js';
import { LANGUAGE_DEPENDENCIES, type WorkspaceDependency } from './dependencies.js';

const tool = (over: Partial<ToolDefinition> & Pick<ToolDefinition, 'name'>): ToolDefinition => ({
  summary: 'does a thing',
  binding: 'environment',
  effect: 'write',
  idempotent: false,
  openWorld: false,
  returns: 'output',
  failures: [{ when: 'it breaks', says: 'it broke' }],
  parameters: { type: 'object', properties: { x: { type: 'string', description: 'x' } } },
  ...over,
});

const REGISTRY = '10.0.0.1:31737';

const CATALOGUE: WorkspaceDependency[] = [
  ...LANGUAGE_DEPENDENCIES,
  { name: 'psql', summary: 'The PostgreSQL client.', provides: ['psql'], install: [{ via: 'dnf', packages: ['postgresql'] }] },
  { name: 'jq', summary: 'jq.', provides: ['jq'], install: [{ via: 'dnf', packages: ['jq'] }] },
  { name: 'ruff', summary: 'ruff.', provides: ['ruff'], install: [{ via: 'pip', packages: ['ruff'] }] },
  { name: 'rg', summary: 'ripgrep.', provides: ['rg'], install: [{ via: 'script', run: 'curl -L example.invalid/rg | tar xz -C /usr/local/bin' }] },
];

const plan = (input: Omit<Parameters<typeof planImage>[0], 'dependencies'>) => planImage({ ...input, dependencies: CATALOGUE });

describe('planning what has to be in the image', () => {
  it('needs no build when every need is the base\'s own', () => {
    const planned = plan({ tools: [tool({ name: 'run_tests', needs: ['node'] })] });

    expect(planned.installs).toEqual([]);
    expect(needsBuilding(planned)).toBe(false);
    expect(imageFor(REGISTRY, planned)).toBe(planned.base);
  });

  it('installs what a tool needs that the base lacks, saying which tool and which dependency', () => {
    const planned = plan({ tools: [tool({ name: 'query_db', needs: ['psql'] })] });

    expect(planned.lines).toEqual([{ install: { via: 'dnf', packages: ['postgresql'] }, from: 'tool:query_db', dependency: 'psql' }]);
    expect(planned.provides).toContain('psql');
    expect(planned.has).toContain('psql');
    expect(needsBuilding(planned)).toBe(true);
  });

  it('installs a dependency once however many things need it', () => {
    const planned = plan({ tools: [tool({ name: 'a', needs: ['jq'] }), tool({ name: 'b', needs: ['jq'] })], needs: [{ name: 'jq', from: 'project' }] });
    expect(planned.lines?.filter((line) => line.dependency === 'jq')).toHaveLength(1);
  });

  it('ignores tools that never run in the workspace', () => {
    expect(plan({ tools: [tool({ name: 'search_web', binding: 'network' })] }).installs).toEqual([]);
  });

  it('refuses a need no dependency answers, naming who asked and what there is', () => {
    expect(() => plan({ tools: [tool({ name: 'query_db', needs: ['cobol'] })] }))
      .toThrow(new UnbuildableError('tool:query_db needs "cobol", which no dependency is called; the workspace can have go, jq, node, psql, python, rg, ruff'));
  });

  it('refuses a base nobody has heard of', () => {
    expect(() => plan({ base: 'cobol', tools: [] })).toThrow(/no base image called "cobol"/);
  });

  it('starts from the base a tool set actually asks for', () => {
    const planned = plan({ base: 'python', tools: [] });

    expect(planned.base).toBe(BASES.find((b) => b.id === 'python')!.image);
    expect(planned.provides).toContain('pip');
  });
});

describe('fingerprinting, so identical tool sets share one image', () => {
  const psql = tool({ name: 'a', needs: ['psql'] });
  const jq = tool({ name: 'b', needs: ['jq'] });

  it('is the same for the same installs in a different order', () => {
    expect(plan({ tools: [psql, jq] }).fingerprint)
      .toBe(plan({ tools: [jq, psql] }).fingerprint);
  });

  it('is the same for the same packages listed in a different order', () => {
    expect(fingerprint('base', [{ via: 'dnf', packages: ['a', 'b'] }]))
      .toBe(fingerprint('base', [{ via: 'dnf', packages: ['b', 'a'] }]));
  });

  it('changes when an install changes', () => {
    expect(plan({ tools: [psql] }).fingerprint).not.toBe(plan({ tools: [psql, jq] }).fingerprint);
  });

  it('changes when the base changes, since the same installs on a different base are a different image', () => {
    expect(plan({ base: 'node', tools: [psql] }).fingerprint)
      .not.toBe(plan({ base: 'python', tools: [psql] }).fingerprint);
  });

  it('is the tag, so the registry can be asked whether it already exists', () => {
    const planned = plan({ tools: [psql] });
    expect(imageReference(REGISTRY, planned)).toBe(`${REGISTRY}/koala/workspace:${planned.fingerprint}`);
  });
});

describe('the Dockerfile it produces', () => {
  it('installs each package manager exactly once, and drops back to a non-root user', () => {
    const planned = plan({ base: 'python', tools: [tool({ name: 'a', needs: ['psql'] }), tool({ name: 'b', needs: ['ruff'] })] });

    const dockerfile = renderDockerfile(planned);

    expect(dockerfile).toContain(`FROM ${planned.base}`);
    expect(dockerfile).toContain('microdnf install -y postgresql');
    expect(dockerfile).toContain('dnf install -y postgresql');
    expect(dockerfile).toContain('python3 -m pip install --no-cache-dir ruff');
    expect(dockerfile.trimEnd().split('\n').at(-2)).toBe('USER 1000');
  });

  it('cleans up after itself so the image does not carry package caches', () => {
    expect(renderDockerfile(plan({ tools: [tool({ name: 'a', needs: ['jq'] })] }))).toContain('microdnf clean all');
  });

  it('runs a script install as written', () => {
    expect(renderDockerfile(plan({ tools: [tool({ name: 'a', needs: ['rg'] })] }))).toContain('RUN curl -L example.invalid/rg');
  });

  it('is just the base when nothing needs installing', () => {
    expect(renderDockerfile(planImage({ tools: [] })).split('\n').filter(Boolean))
      .toEqual([`FROM ${BASES.find((b) => b.id === DEFAULT_BASE)!.image}`, 'USER root', 'USER 1000']);
  });
});

describe('the languages a workspace asks for', () => {
  it('installs a language the base does not already have', () => {
    const plan = planImage({ base: 'node', languages: ['node', 'go'], tools: [] });

    expect(plan.installs).toEqual([{ via: 'dnf', packages: ['go-toolset'] }]);
    expect(plan.lines).toEqual([{ install: { via: 'dnf', packages: ['go-toolset'] }, from: 'language:go', dependency: 'go' }]);
    expect(needsBuilding(plan)).toBe(true);
    expect(plan.provides).toContain('go');
  });

  it('builds nothing when the base already serves every language asked for', () => {
    const plan = planImage({ base: 'python', languages: ['python', 'node'], tools: [] });

    expect(plan.installs).toEqual([]);
    expect(needsBuilding(plan)).toBe(false);
  });

  it('installs pip for a python workspace on the node base, which has none', () => {
    const plan = planImage({ base: 'node', languages: ['node', 'python'], tools: [] });

    expect(plan.installs).toEqual([{ via: 'dnf', packages: ['python3', 'python3-pip'] }]);
  });

  it('refuses a language it has no way to install', () => {
    expect(() => planImage({ base: 'node', languages: ['cobol'], tools: [] }))
      .toThrow(UnbuildableError);
  });

  it('gives a different fingerprint once a language is added', () => {
    const before = planImage({ base: 'node', languages: ['node'], tools: [] });
    const after = planImage({ base: 'node', languages: ['node', 'go'], tools: [] });

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe('choosing the base from the languages', () => {
  it('takes the first language when it is a base of its own', () => {
    expect(baseFor({ environment: { languages: ['python', 'node'] } })).toBe('python');
  });

  it('falls back to the default when the first is not a base it knows', () => {
    expect(baseFor({ environment: { languages: ['cobol'] } })).toBe(DEFAULT_BASE);
  });

  it('reads every language, not only the one that picked the base', () => {
    expect(languagesFor({ environment: { languages: ['node', 'go'] } })).toEqual(['node', 'go']);
  });
});

describe('a base image a host adds', () => {
  const odoo = {
    id: 'odoo',
    image: 'odoo:18',
    provides: ['bash', 'python3', 'odoo'],
    setup: [{ via: 'apt' as const, packages: ['postgresql-18'] }, { via: 'script' as const, run: 'echo checker > /usr/local/bin/odoo-check' }],
  };
  const bases = [...BASES, odoo];

  it('is chosen when a workspace asks for it, even after other languages, and its setup is built in first', () => {
    expect(baseFor({ environment: { languages: ['node', 'odoo'] } }, bases)).toBe('odoo');
    const plan = planImage({ base: 'odoo', languages: ['odoo'], tools: [], bases });
    expect(plan.base).toBe('odoo:18');
    expect(plan.installs).toEqual(odoo.setup);
    expect(renderDockerfile(plan)).toContain('apt-get install -y --no-install-recommends postgresql-18');
  });

  it('is unknown to a planner that was not given it', () => {
    expect(() => planImage({ base: 'odoo', tools: [] })).toThrow(/no base image called "odoo"/);
    expect(baseFor({ environment: { languages: ['odoo'] } })).toBe(DEFAULT_BASE);
  });

  it('changes the fingerprint when its setup changes', () => {
    const changed = { ...odoo, setup: [odoo.setup[0]!] };
    expect(planImage({ base: 'odoo', tools: [], bases }).fingerprint).not.toBe(planImage({ base: 'odoo', tools: [], bases: [...BASES, changed] }).fingerprint);
  });

  it('installs a tool\'s dnf packages with apt-get on a base that has no dnf', () => {
    const jq = tool({ name: 'json_query', needs: ['jq'] });
    const dockerfile = renderDockerfile(planImage({ base: 'odoo', tools: [jq], bases, dependencies: CATALOGUE }));
    expect(dockerfile).toMatch(/elif command -v dnf .* else apt-get update && apt-get install -y --no-install-recommends jq/);
  });

  it('asks apt for a language by the name apt knows it by, and keeps the fingerprint the same', () => {
    const plan = planImage({ base: 'odoo', languages: ['odoo', 'node', 'go'], tools: [], bases });
    expect(renderDockerfile(plan)).toMatch(/else apt-get update && apt-get install -y --no-install-recommends golang-go/);
    expect(renderDockerfile(plan)).toMatch(/microdnf install -y go-toolset/);
  });
});

describe('where each line of a workspace image comes from', () => {
  const rg = { name: 'count_lines', binding: 'environment', needs: ['ripgrep'] } as never;
  const dependencies = [...LANGUAGE_DEPENDENCIES, { name: 'ripgrep', summary: 'ripgrep.', provides: ['rg'], install: [{ via: 'dnf' as const, packages: ['ripgrep'] }] }];

  it('says, for every install, whether the base, a language, the project or a tool put it there', () => {
    const plan = planImage({
      base: 'node',
      languages: ['go'],
      tools: [rg],
      contributions: [{ from: 'project', install: { via: 'dnf', packages: ['wkhtmltopdf'] }, provides: ['wkhtmltopdf'] }],
      dependencies,
    });

    expect(plan.lines).toEqual([
      { install: { via: 'dnf', packages: ['go-toolset'] }, from: 'language:go', dependency: 'go' },
      { install: { via: 'dnf', packages: ['ripgrep'] }, from: 'tool:count_lines', dependency: 'ripgrep' },
      { install: { via: 'dnf', packages: ['wkhtmltopdf'] }, from: 'project' },
    ]);
    expect(plan.installs).toEqual(plan.lines!.map((line) => line.install));
    expect(plan.provides).toContain('wkhtmltopdf');
  });

  it('keeps the fingerprint a matter of what is installed, so labelling it rebuilds nothing', () => {
    const plan = planImage({ base: 'node', tools: [rg], dependencies });
    expect(plan.fingerprint).toBe(fingerprint('registry.access.redhat.com/ubi9/nodejs-22', [{ via: 'dnf', packages: ['ripgrep'] }]));
  });

  it('installs the package manager a line needs first, when the base has none', () => {
    const plan = planImage({ base: 'node', tools: [], contributions: [{ from: 'project', install: { via: 'pip', packages: ['cowsay'] } }] });
    expect(plan.lines).toEqual([
      { install: { via: 'dnf', packages: ['python3', 'python3-pip'] }, from: 'project', dependency: 'python' },
      { install: { via: 'pip', packages: ['cowsay'] }, from: 'project' },
    ]);
    expect(planImage({ base: 'python', tools: [], contributions: [{ from: 'project', install: { via: 'pip', packages: ['cowsay'] } }, { from: 'project', install: { via: 'npm', packages: ['left-pad'] } }] }).lines!.map((line) => line.from)).toEqual(['project', 'project']);
    expect(planImage({ base: 'minimal', tools: [], contributions: [{ from: 'project', install: { via: 'npm', packages: ['left-pad'] } }, { from: 'project', install: { via: 'npm', packages: ['is-odd'] } }] }).lines!.map((line) => line.from)).toEqual(['project', 'project', 'project']);
  });

  it('adds nothing for a contribution the base already provides', () => {
    expect(planImage({ base: 'node', tools: [], contributions: [{ from: 'project', install: { via: 'base' } }] }).lines).toEqual([]);
  });

  it('leaves out a contribution whose programs the base already has', () => {
    const fonts = { from: 'project', install: { via: 'script' as const, run: 'install fonts' }, provides: ['fc-list'] };
    const bases = [...BASES, { id: 'has-fonts', image: 'fonts:1', provides: ['bash', 'fc-list'] }];
    expect(planImage({ base: 'node', tools: [], contributions: [fonts], bases }).lines).toEqual([{ install: fonts.install, from: 'project' }]);
    expect(planImage({ base: 'has-fonts', tools: [], contributions: [fonts], bases }).lines).toEqual([]);
  });
});

describe('dependencies that need other dependencies', () => {
  const chromium: WorkspaceDependency = { name: 'chromium', summary: 'Chromium.', provides: ['chromium'], install: [{ via: 'dnf', packages: ['nss'] }], onDebian: [{ via: 'apt', packages: ['libnss3'] }] };
  const playwright: WorkspaceDependency = { name: 'playwright', summary: 'Playwright.', provides: ['playwright'], needs: ['chromium'], install: [{ via: 'npm', packages: ['@playwright/test@1.48.2'] }] };
  const runner: WorkspaceDependency = { name: 'koala-e2e', summary: 'The runner.', provides: ['koala-e2e'], needs: ['playwright'], install: [{ via: 'script', run: 'write koala-e2e' }] };
  const dependencies = [...LANGUAGE_DEPENDENCIES, chromium, playwright, runner];
  const debian = { id: 'debby', image: 'debian:1', family: 'debian' as const, provides: ['bash'] };
  const ready = { id: 'ready', image: 'ready:1', provides: ['bash', 'node', 'npm', 'koala-e2e', 'playwright', 'chromium'], has: ['koala-e2e', 'playwright', 'chromium'] };
  const bases = [...BASES, debian, ready];

  it('installs what each needs first, a package manager included, each once', () => {
    const planned = planImage({ base: 'minimal', tools: [], needs: [{ name: 'koala-e2e', from: 'check:e2e' }, { name: 'chromium', from: 'project' }], bases, dependencies });
    expect(planned.lines!.map((line) => line.dependency)).toEqual(['chromium', 'node', 'playwright', 'koala-e2e']);
    expect(planned.lines!.every((line) => line.from === 'check:e2e')).toBe(true);
  });

  it('installs nothing a base already has, and a Debian base its own way', () => {
    expect(planImage({ base: 'ready', tools: [], needs: [{ name: 'koala-e2e', from: 'check:e2e' }], bases, dependencies }).lines).toEqual([]);
    expect(planImage({ base: 'debby', tools: [], needs: [{ name: 'chromium', from: 'project' }], bases, dependencies }).lines)
      .toEqual([{ install: { via: 'apt', packages: ['libnss3'] }, from: 'project', dependency: 'chromium' }]);
  });

  it('refuses dependencies that need each other in a circle', () => {
    const a: WorkspaceDependency = { name: 'a', summary: 'a.', provides: ['a'], needs: ['b'], install: [{ via: 'dnf', packages: ['a'] }] };
    const b: WorkspaceDependency = { name: 'b', summary: 'b.', provides: ['b'], needs: ['a'], install: [{ via: 'dnf', packages: ['b'] }] };
    expect(() => planImage({ tools: [], needs: [{ name: 'a', from: 'project' }], dependencies: [a, b] })).toThrow('these dependencies need each other in a circle: a → b → a');
  });

  it('takes a language that names a base as the base, not as something to install', () => {
    const odoo = { id: 'odoo', image: 'odoo:18', provides: ['bash', 'python3', 'odoo'] };
    expect(planImage({ base: 'odoo', languages: ['odoo'], tools: [], bases: [...BASES, odoo] }).lines).toEqual([]);
  });
});

describe('proving what was promised, as the workspace user, at the end of the build', () => {
  it('checks every program and library each dependency it installs promised, and nothing for a plain base', () => {
    const fonts: WorkspaceDependency = { name: 'fonts', summary: 'fonts.', provides: [], libraries: ['libfreetype.so.6'], install: [{ via: 'dnf', packages: ['freetype'] }] };
    const planned = plan({ tools: [tool({ name: 'a', needs: ['jq'] })] });
    expect(planImage({ tools: [], needs: [{ name: 'fonts', from: 'project' }], dependencies: [...CATALOGUE, fonts] }).proves).toEqual([{ dependency: 'fonts', programs: [], libraries: ['libfreetype.so.6'] }]);
    expect(planned.proves).toEqual([{ dependency: 'jq', programs: ['jq'], libraries: [] }]);
    const dockerfile = renderDockerfile(planned).trimEnd().split('\n');
    expect(dockerfile.at(-2)).toBe('USER 1000');
    expect(dockerfile.at(-1)).toBe(`RUN ${proofScript(planned.proves!)}`);
    expect(proofScript(planned.proves!)).toContain(`command -v 'jq' >/dev/null 2>&1 || missing="$missing jq:jq"`);
    expect(renderDockerfile(plan({ tools: [] }))).not.toContain('missing=');
  });
});
