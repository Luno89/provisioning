import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import {
  TREE_TYPE_SEEDS, validateTreeType, resolveTreeType, renderStarterFiles, leafValidationRecipe,
  resolveCustomSteps, flattenRecipeLeaves, type TreeTypeSpec,
} from './tree-types.js';
import type { CustomStepDefinition } from './custom-steps.js';

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

describe('validation recipe steps', () => {
  it('accepts retries and optional on a plain check', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'a', name: 'A', type: 'run-command', command: 'true', retries: 2, retryDelayMs: 500, optional: true }],
      },
    }));
    expect(result).toBeNull();
  });

  it('refuses negative retries', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'a', name: 'A', type: 'run-command', command: 'true', retries: -1 }],
      },
    }));
    expect(result).toMatch(/retries/i);
  });

  it('accepts runIf naming an earlier check', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [
          { id: 'a', name: 'A', type: 'run-command', command: 'true' },
          { id: 'b', name: 'B', type: 'run-command', command: 'true', runIf: 'a' },
        ],
      },
    }));
    expect(result).toBeNull();
  });

  it('refuses runIf naming a check that does not exist', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'a', name: 'A', type: 'run-command', command: 'true', runIf: 'ghost' }],
      },
    }));
    expect(result).toMatch(/runIf/);
  });

  it('refuses runIf naming a check that comes later (forward reference)', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [
          { id: 'a', name: 'A', type: 'run-command', command: 'true', runIf: 'b' },
          { id: 'b', name: 'B', type: 'run-command', command: 'true' },
        ],
      },
    }));
    expect(result).toMatch(/runIf/);
  });

  it('requires kind and namespace on a k8s-probe check', () => {
    expect(validateTreeType(IMAGES, spec({
      validationRecipe: { type: 'runtime-service', checks: [{ id: 'a', name: 'A', type: 'k8s-probe', target: 'my-pod', namespace: 'default', kind: 'pod' }] },
    }))).toBeNull();

    expect(validateTreeType(IMAGES, spec({
      validationRecipe: { type: 'runtime-service', checks: [{ id: 'a', name: 'A', type: 'k8s-probe', target: 'my-pod' }] },
    }))).toMatch(/kind/i);

    expect(validateTreeType(IMAGES, spec({
      validationRecipe: { type: 'runtime-service', checks: [{ id: 'a', name: 'A', type: 'k8s-probe', target: 'my-pod', kind: 'pod' }] },
    }))).toMatch(/namespace/i);
  });

  it('requires waitForType on a wait-for check, and refuses it naming wait-for itself', () => {
    expect(validateTreeType(IMAGES, spec({
      validationRecipe: { type: 'runtime-service', checks: [{ id: 'a', name: 'A', type: 'wait-for', waitForType: 'http-probe', target: 'http://x/health' }] },
    }))).toBeNull();

    expect(validateTreeType(IMAGES, spec({
      validationRecipe: { type: 'runtime-service', checks: [{ id: 'a', name: 'A', type: 'wait-for' }] },
    }))).toMatch(/waitForType/);

    expect(validateTreeType(IMAGES, spec({
      validationRecipe: { type: 'runtime-service', checks: [{ id: 'a', name: 'A', type: 'wait-for', waitForType: 'wait-for' as never }] },
    }))).toMatch(/waitForType/);
  });

  it('refuses a pollIntervalMs larger than the check\'s own timeoutMs', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'runtime-service',
        checks: [{ id: 'a', name: 'A', type: 'wait-for', waitForType: 'http-probe', target: 'x', timeoutMs: 1000, pollIntervalMs: 5000 }],
      },
    }));
    expect(result).toMatch(/pollIntervalMs/);
  });
});

describe('nested groups and loops', () => {
  it('accepts a group containing checks', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{
          id: 'g1', name: 'Group', containerType: 'group',
          children: [{ id: 'a', name: 'A', type: 'run-command', command: 'true' }],
        }],
      },
    }));
    expect(result).toBeNull();
  });

  it('accepts a runIf inside a group referencing a node outside it', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [
          { id: 'a', name: 'A', type: 'run-command', command: 'true' },
          {
            id: 'g1', name: 'Group', containerType: 'group',
            children: [{ id: 'b', name: 'B', type: 'run-command', command: 'true', runIf: 'a' }],
          },
        ],
      },
    }));
    expect(result).toBeNull();
  });

  it('accepts a runIf after a loop referencing a node nested inside it', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [
          {
            id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'count', maxIterations: 3,
            children: [{ id: 'a', name: 'A', type: 'run-command', command: 'true' }],
          },
          { id: 'b', name: 'B', type: 'run-command', command: 'true', runIf: 'a' },
        ],
      },
    }));
    expect(result).toBeNull();
  });

  it('refuses a runIf naming a node that only appears later, even across a container boundary', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [
          { id: 'a', name: 'A', type: 'run-command', command: 'true', runIf: 'b' },
          {
            id: 'g1', name: 'Group', containerType: 'group',
            children: [{ id: 'b', name: 'B', type: 'run-command', command: 'true' }],
          },
        ],
      },
    }));
    expect(result).toMatch(/runIf/);
  });

  it('refuses an unknown containerType', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'x', name: 'X', containerType: 'bogus' as never, children: [] }],
      },
    }));
    expect(result).toMatch(/containerType/i);
  });

  it('requires maxIterations on a count loop', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'count', children: [] }],
      },
    }));
    expect(result).toMatch(/maxIterations/i);
  });

  it('requires maxIterations on an until loop', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'until', children: [] }],
      },
    }));
    expect(result).toMatch(/maxIterations/i);
  });

  it('requires itemsCommand on a forEach loop', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'forEach', children: [] }],
      },
    }));
    expect(result).toMatch(/itemsCommand/i);
  });

  it('accepts a forEach loop with itemsCommand and no maxIterations', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{
          id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'forEach', itemsCommand: 'ls',
          children: [{ id: 'a', name: 'A', type: 'run-command', command: 'echo {{item}}' }],
        }],
      },
    }));
    expect(result).toBeNull();
  });

  it('refuses an unknown loopType', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{ id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'while' as never, children: [] }],
      },
    }));
    expect(result).toMatch(/loopType/i);
  });

  it('validates leaves nested arbitrarily deep', () => {
    const result = validateTreeType(IMAGES, spec({
      validationRecipe: {
        type: 'command',
        checks: [{
          id: 'g1', name: 'Outer', containerType: 'group',
          children: [{
            id: 'l1', name: 'Inner loop', containerType: 'loop', loopType: 'count', maxIterations: 2,
            children: [{ id: 'a', name: 'A', type: 'run-command', command: 'true', retries: -1 }],
          }],
        }],
      },
    }));
    expect(result).toMatch(/retries/i);
  });
});

describe('leafValidationRecipe — what a leaf sees mid-run vs final verification', () => {
  it('strips a k8s-probe, same as it already strips http-probe and mcp-probe', () => {
    const stripped = leafValidationRecipe({
      type: 'runtime-service',
      checks: [
        { id: 'file', name: 'File', type: 'file-exists', target: 'x' },
        { id: 'k8s', name: 'K8s', type: 'k8s-probe', target: 'my-pod', namespace: 'default', kind: 'pod' },
      ],
    });
    expect(stripped?.checks.map((c) => c.id)).toEqual(['file']);
  });

  it('strips a wait-for that wraps a runtime probe, since the sandbox has no cluster/network access mid-leaf', () => {
    const stripped = leafValidationRecipe({
      type: 'runtime-service',
      checks: [
        { id: 'file', name: 'File', type: 'file-exists', target: 'x' },
        { id: 'wait', name: 'Wait', type: 'wait-for', waitForType: 'http-probe', target: 'http://x/health' },
      ],
    });
    expect(stripped?.checks.map((c) => c.id)).toEqual(['file']);
  });

  it('keeps a wait-for that wraps a non-runtime-probe check', () => {
    const stripped = leafValidationRecipe({
      type: 'command',
      checks: [
        { id: 'wait', name: 'Wait', type: 'wait-for', waitForType: 'file-exists', target: 'x' },
      ],
    });
    expect(stripped?.checks.map((c) => c.id)).toEqual(['wait']);
  });

  it('strips a runtime-probe buried inside a group, without dropping its sibling', () => {
    const stripped = leafValidationRecipe({
      type: 'runtime-service',
      checks: [{
        id: 'g1', name: 'Group', containerType: 'group',
        children: [
          { id: 'file', name: 'File', type: 'file-exists', target: 'x' },
          { id: 'k8s', name: 'K8s', type: 'k8s-probe', target: 'my-pod', namespace: 'default', kind: 'pod' },
        ],
      }],
    });
    const group = stripped?.checks[0];
    expect(group && 'children' in group ? group.children.map((c) => c.id) : undefined).toEqual(['file']);
  });

  it('drops a group entirely once every runtime-probe child is stripped', () => {
    const stripped = leafValidationRecipe({
      type: 'runtime-service',
      checks: [
        { id: 'keep', name: 'Keep', type: 'file-exists', target: 'x' },
        {
          id: 'g1', name: 'Group', containerType: 'group',
          children: [{ id: 'k8s', name: 'K8s', type: 'k8s-probe', target: 'my-pod', namespace: 'default', kind: 'pod' }],
        },
      ],
    });
    expect(stripped?.checks.map((c) => c.id)).toEqual(['keep']);
  });

  it('strips a runtime-probe nested inside a loop inside a group', () => {
    const stripped = leafValidationRecipe({
      type: 'runtime-service',
      checks: [{
        id: 'g1', name: 'Group', containerType: 'group',
        children: [{
          id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'count', maxIterations: 2,
          children: [
            { id: 'file', name: 'File', type: 'file-exists', target: 'x' },
            { id: 'http', name: 'Http', type: 'http-probe', target: 'http://x/health' },
          ],
        }],
      }],
    });
    const group = stripped?.checks[0];
    const loop = group && 'children' in group ? group.children[0] : undefined;
    expect(loop && 'children' in loop ? loop.children.map((c) => c.id) : undefined).toEqual(['file']);
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

describe('resolveCustomSteps', () => {
  const lighthouse: CustomStepDefinition = {
    id: 'lighthouse', ownerId: 'u1', name: 'Lighthouse',
    fields: [{ key: 'url', label: 'URL', kind: 'string' }],
    command: 'lighthouse {{url}}',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };

  it('expands a custom check into an equivalent run-command check', () => {
    const resolved = resolveCustomSteps(
      { type: 'command', checks: [{ id: 'a', name: 'Lighthouse score', type: 'custom', customStepId: 'lighthouse', params: { url: 'https://x.dev' } }] },
      [lighthouse],
    );
    expect(resolved?.checks[0]).toMatchObject({ id: 'a', type: 'run-command', command: 'lighthouse https://x.dev' });
  });

  it('preserves control-flow fields (optional, runIf, retries) across the expansion', () => {
    const resolved = resolveCustomSteps(
      {
        type: 'command',
        checks: [{
          id: 'a', name: 'Lighthouse', type: 'custom', customStepId: 'lighthouse', params: { url: 'x' },
          optional: true, runIf: 'earlier', retries: 2,
        }],
      },
      [lighthouse],
    );
    expect(resolved?.checks[0]).toMatchObject({ optional: true, runIf: 'earlier', retries: 2 });
  });

  it('resolves a wait-for wrapping a custom step', () => {
    const resolved = resolveCustomSteps(
      {
        type: 'runtime-service',
        checks: [{
          id: 'a', name: 'Wait for it', type: 'wait-for', waitForType: 'custom',
          customStepId: 'lighthouse', params: { url: 'https://x.dev' }, timeoutMs: 5000,
        }],
      },
      [lighthouse],
    );
    expect(resolved?.checks[0]).toMatchObject({ type: 'wait-for', waitForType: 'run-command', command: 'lighthouse https://x.dev' });
  });

  it('leaves non-custom checks untouched', () => {
    const recipe = { type: 'command' as const, checks: [{ id: 'a', name: 'File', type: 'file-exists' as const, target: 'x' }] };
    expect(resolveCustomSteps(recipe, [lighthouse])).toEqual(recipe);
  });

  it('resolves a dangling reference to a definition that no longer exists into an always-failing check, not a throw', () => {
    const resolved = resolveCustomSteps(
      { type: 'command', checks: [{ id: 'a', name: 'Gone', type: 'custom', customStepId: 'deleted-def' }] },
      [],
    );
    const [leaf] = flattenRecipeLeaves(resolved?.checks ?? []);
    expect(leaf?.type).toBe('run-command');
    expect(leaf?.command).toContain('no longer exists');
  });

  it('passes undefined through unchanged', () => {
    expect(resolveCustomSteps(undefined, [lighthouse])).toBeUndefined();
  });

  it('expands a custom check nested inside a loop inside a group', () => {
    const resolved = resolveCustomSteps(
      {
        type: 'command',
        checks: [{
          id: 'g1', name: 'Group', containerType: 'group',
          children: [{
            id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'count', maxIterations: 2,
            children: [{ id: 'a', name: 'Lighthouse score', type: 'custom', customStepId: 'lighthouse', params: { url: 'https://x.dev' } }],
          }],
        }],
      },
      [lighthouse],
    );
    const [leaf] = flattenRecipeLeaves(resolved?.checks ?? []);
    expect(leaf).toMatchObject({ id: 'a', type: 'run-command', command: 'lighthouse https://x.dev' });
  });
});
