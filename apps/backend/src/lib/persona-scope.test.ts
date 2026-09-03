import { describe, it, expect } from 'vitest';
import { allowedTools, usesRepo, flattenPack, personaWorkspace } from './persona-scope.js';
import type { PersonaPack } from '@koala/harness-types';
import type { TreeTypeSpec } from './tree-types.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { seedsByLanguage as BY_LANGUAGE } from './workspace-image-seeds.js';

const p = (name: string, over?: { tools?: string[] }) =>
  ({ name, tools: over?.tools ?? [] }) as Pick<PersonaPack, 'name' | 'tools'>;

const tt = (over?: { produces?: TreeTypeSpec['produces'] }) =>
  ({ produces: over?.produces }) as Pick<TreeTypeSpec, 'produces'>;

describe('the tools a persona actually gets', () => {
  const ALL = ['run_command', 'write_file', 'read_file', 'finish', 'web_search', 'fetch_web_page'];

  it('holds a persona to the subset it declared', () => {
    expect(allowedTools(p('Framer', { tools: ['write_file', 'read_file', 'finish'] }), ALL))
      .toEqual(['write_file', 'read_file', 'finish']);
  });

  it('does not conjure a tool the environment lacks', () => {
    expect(allowedTools(p('Researcher', { tools: ['web_search', 'write_file'] }), ['write_file', 'finish']))
      .toEqual(['write_file']);
  });

  it('gives an undeclared persona everything, as before', () => {
    expect(allowedTools(p('Coder'), ALL)).toEqual(ALL);
    expect(allowedTools(null, ALL)).toEqual(ALL);
  });

  it('treats an empty list as undeclared rather than as "no tools"', () => {
    expect(allowedTools(p('X', { tools: [] }), ALL)).toEqual(ALL);
  });
});

describe('whether a tree type works in the repository', () => {
  it('defaults to NO for an artefact — most work is not a codebase', () => {
    expect(usesRepo(tt({ produces: 'artefact' }))).toBe(false);
    expect(usesRepo(null)).toBe(false);
  });

  it('gives one to a tree type that produces a service', () => {
    expect(usesRepo(tt({ produces: 'service' }))).toBe(true);
  });
});

describe('a persona defined as "that one, but ..."', () => {
  type Flat = { id: string; slug?: string; basedOn?: string; name?: string; systemPrompt?: string; sampling?: { toolTurn: Record<string, number>; conversation: Record<string, number> }; tools?: string[]; output?: string; budget?: { run?: { steps?: number; withdraw?: { afterStep: number; tools: string[] } } } };
  const parent: Flat = {
    id: 'researcher', name: 'Researcher', systemPrompt: 'answer one question',
    sampling: { toolTurn: { temperature: 0.4 }, conversation: {} },
    tools: ['web_search', 'write_file', 'finish'],
    output: '/work/findings.md',
    budget: { run: { steps: 100, withdraw: { afterStep: 50, tools: ['web_search'] } } },
  };

  it('inherits everything it does not change', () => {
    const child: Flat = { id: 'short', name: 'Researcher (short)', sampling: { toolTurn: { temperature: 0.4 }, conversation: {} }, basedOn: 'researcher',
      budget: { run: { steps: 40 } } };
    const flat = flattenPack(child, [parent, child]);
    expect(flat.budget!.run!.steps).toBe(40);
    expect(flat.systemPrompt).toBe('answer one question');
    expect(flat.tools).toEqual(['web_search', 'write_file', 'finish']);
    expect(flat.output).toBe('/work/findings.md');
    expect(flat.budget!.run!.withdraw).toEqual({ afterStep: 50, tools: ['web_search'] });
    expect(flat.sampling!.toolTurn.temperature).toBe(0.4);
  });

  it('lets the child win field by field', () => {
    const child: Flat = { id: 'cold', name: 'Researcher (cold)', sampling: { toolTurn: { temperature: 0.1 }, conversation: {} }, basedOn: 'researcher' };
    const flat = flattenPack(child, [parent, child]);
    expect(flat.sampling!.toolTurn.temperature).toBe(0.1);
    expect(flat.budget!.run!.steps).toBe(100);
  });

  it('ignores a parent that no longer exists rather than failing the work', () => {
    const orphan: Flat = { id: 'x', name: 'Orphan', sampling: { toolTurn: { temperature: 0.4 }, conversation: {} }, basedOn: 'deleted' };
    expect(flattenPack(orphan, [orphan]).name).toBe('Orphan');
  });

  it('stops at a cycle instead of looping forever', () => {
    const a: Flat = { id: 'a', name: 'A', sampling: { toolTurn: { temperature: 0.4 }, conversation: {} }, basedOn: 'b' };
    const b: Flat = { id: 'b', name: 'B', sampling: { toolTurn: { temperature: 0.4 }, conversation: {} }, basedOn: 'a' };
    expect(flattenPack(a, [a, b]).name).toBe('A');
  });
});

describe('the container a leaf runs in', () => {
  const ids = { leafId: 'leaf-1', ownerId: 'u1' };

  it('takes everything it can from the work', () => {
    const spec = personaWorkspace(IMAGES, ids, {
      language: 'go',
      egress: [{ namespace: 'gitea', ports: [3000] }],
      env: [{ name: 'TOKEN', value: 'x' }],
    });
    expect(spec).toMatchObject({ leafId: 'leaf-1', ownerId: 'u1' });
    expect(spec.egress).toContainEqual({ namespace: 'gitea', ports: [3000] });
    expect(spec.env).toContainEqual({ name: 'TOKEN', value: 'x' });
    expect(spec.image).toContain('go-toolset');
  });

  it("lets the project's toolchain win when both are named", () => {
    const spec = personaWorkspace(IMAGES, ids, { language: 'go' });
    expect(spec.image).toContain('go-toolset');
  });

  it('resolves the default image when no language is named', () => {
    // It used to leave this undefined and let `buildWorkspaceManifests` fill it in from a module
    // constant — the same node image, decided in a second place. The pod is unchanged; what the
    // work declares is now the truth.
    expect(personaWorkspace(IMAGES, ids, {}).image).toBe(BY_LANGUAGE.node.image);
  });

  it('distinguishes an unstated network from a deliberately closed one', () => {
    expect(personaWorkspace(IMAGES, ids, {}).egress).toBeUndefined();
    expect(personaWorkspace(IMAGES, ids, { egress: [] }).egress).toEqual([]);
  });

  it('carries nothing extra when the work declares nothing', () => {
    expect(personaWorkspace(IMAGES, ids, {}))
      .toEqual({ leafId: 'leaf-1', ownerId: 'u1', image: BY_LANGUAGE.node.image });
  });
});

describe('the network a checkout needs', () => {
  const ids = { leafId: 'leaf-1', ownerId: 'u' };
  const gitea = (spec: { egress?: readonly { namespace?: string | undefined; ports?: number[] | undefined }[] | undefined }) =>
    (spec.egress ?? []).find((r) => r.namespace === 'gitea');

  it('opens Gitea for work checking out a repository', () => {
    const spec = personaWorkspace(IMAGES, ids, { checkout: true });
    expect(gitea(spec)?.ports).toContain(3000);
  });

  it('leaves work with no checkout unable to reach it', () => {
    const spec = personaWorkspace(IMAGES, ids, {});
    expect(gitea(spec)).toBeUndefined();
  });

  it('does not double the rule when the tree type already declared it', () => {
    const spec = personaWorkspace(IMAGES, ids, {
      checkout: true,
      egress: [{ namespace: 'gitea', ports: [3000] }],
    });
    expect((spec.egress ?? []).filter((r) => r.namespace === 'gitea')).toHaveLength(1);
  });
});

describe('what a workspace can install', () => {
  const spec = (language: string | undefined, over: { env?: { name: string; value: string }[] } = {}) =>
    personaWorkspace(IMAGES, { leafId: 'leaf-1', ownerId: 'u' }, { language, ...over });

  it('gives a python workspace pip access with no tree-type env at all', () => {
    const s = spec('python');
    expect((s.env ?? []).find((e) => e.name === 'PIP_INDEX_URL')).toBeTruthy();
    expect((s.egress ?? []).find((r) => r.namespace === 'koala-egress')?.ports).toContain(8888);
  });

  it('gives a node workspace the npm mirror instead', () => {
    const s = spec('node');
    expect((s.env ?? []).find((e) => e.name === 'NPM_CONFIG_REGISTRY')).toBeTruthy();
    expect((s.egress ?? []).find((r) => r.namespace === 'koala-egress')).toBeUndefined();
  });

  it('lets a tree type override the index without ending up with two of them', () => {
    const s = spec('node', { env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://internal:4873' }] });
    const npm = (s.env ?? []).filter((e) => e.name === 'NPM_CONFIG_REGISTRY');
    expect(npm).toHaveLength(1);
    expect(npm[0]!.value).toBe('http://internal:4873');
  });

  it('opens no package egress for a prose workspace', () => {
    const s = spec('base');
    expect((s.egress ?? []).find((r) => r.namespace === 'koala-egress')).toBeUndefined();
    expect((s.egress ?? []).find((r) => r.namespace === 'koala-registry')).toBeUndefined();
  });
});

describe('a pack based on another inherits the config fields that replaced overrides', () => {
  const parent = {
    id: 'base', name: 'Base', slug: 'base',
    sampling: { toolTurn: { temperature: 0.3, top_p: 0.9 }, conversation: { frequency_penalty: 0.4 } },
    budget: { rounds: 8, run: { steps: 200, tokens: 1000 } },
    prompt: { pressure: { compactAt: 0.4 }, sections: { secrets: 'parent secrets' } },
  } as never;

  it('takes one field from the child and the rest from the parent', () => {
    const child = {
      id: 'hot', name: 'Hot', slug: 'hot', basedOn: 'base',
      sampling: { toolTurn: { temperature: 0.9 } },
    } as never;
    const flat = flattenPack(child, [parent, child]) as never as {
      sampling: { toolTurn: Record<string, number>; conversation: Record<string, number> };
      budget: { rounds: number; run: { steps: number } };
      prompt: { sections: { secrets: string } };
    };

    expect(flat.sampling.toolTurn.temperature).toBe(0.9);
    expect(flat.sampling.toolTurn.top_p).toBe(0.9);
    expect(flat.sampling.conversation.frequency_penalty).toBe(0.4);
    expect(flat.budget.rounds).toBe(8);
    expect(flat.budget.run.steps).toBe(200);
    expect(flat.prompt.sections.secrets).toBe('parent secrets');
  });

  it('lets a child blank a prompt section without losing the rest of the pack', () => {
    const child = {
      id: 'quiet', name: 'Quiet', slug: 'quiet', basedOn: 'base',
      prompt: { sections: { secrets: '' } },
    } as never;
    const flat = flattenPack(child, [parent, child]) as never as {
      prompt: { sections: { secrets: string }; pressure: { compactAt: number } };
      budget: { rounds: number };
    };

    expect(flat.prompt.sections.secrets).toBe('');
    expect(flat.prompt.pressure.compactAt).toBe(0.4);
    expect(flat.budget.rounds).toBe(8);
  });
});
