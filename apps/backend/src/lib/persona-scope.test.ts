import { describe, it, expect } from 'vitest';
import { allowedTools, usesRepo, flattenPack, personaWorkspace } from './persona-scope.js';
import type { PersonaPack, WorkspaceScope } from '@koala/harness-types';

const p = (name: string, over?: { tools?: string[]; workspace?: WorkspaceScope }) =>
  ({ name, tools: over?.tools ?? [], ...(over?.workspace ? { workspace: over.workspace } : {}) }) as
    Pick<PersonaPack, 'name' | 'tools' | 'workspace'>;

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

describe('whether a persona works in the repository', () => {
  it('defaults to NO, because most work is not a codebase', () => {
    expect(usesRepo(p('Researcher'))).toBe(false);
    expect(usesRepo(p('Researcher', {}))).toBe(false);
    expect(usesRepo(null)).toBe(false);
  });

  it('gives one to a persona that asks', () => {
    expect(usesRepo(p('Builder', { workspace: { repo: true }}))).toBe(true);
  });

  it('treats an explicit false the same as saying nothing', () => {
    expect(usesRepo(p('Researcher', { workspace: { repo: false }}))).toBe(false);
  });
});

describe('a persona defined as "that one, but ..."', () => {
  type Flat = { id: string; slug?: string; basedOn?: string; name?: string; systemPrompt?: string; overrides?: Record<string, unknown>; tools?: string[]; workspace?: Record<string, unknown> };
  const parent: Flat = {
    id: 'researcher', name: 'Researcher', systemPrompt: 'answer one question',
    overrides: { temperature: 0.4 },
    tools: ['web_search', 'write_file', 'finish'], workspace: {
      repo: false,
      output: '/work/findings.md',
      run: { maxSteps: 100, withdraw: { afterStep: 50, tools: ['web_search'] } },
    },
  };

  it('inherits everything it does not change', () => {
    const child: Flat = { id: 'short', name: 'Researcher (short)', overrides: {}, basedOn: 'researcher',
      workspace: { run: { maxSteps: 40 } } };
    const flat = flattenPack(child, [parent, child]);
    expect((flat.workspace!.run as any).maxSteps).toBe(40);
    expect(flat.systemPrompt).toBe('answer one question');
    expect(flat.tools).toEqual(['web_search', 'write_file', 'finish']);
    expect(flat.workspace!.repo).toBe(false);
    expect(flat.workspace!.output).toBe('/work/findings.md');
    expect((flat.workspace!.run as any).withdraw).toEqual({ afterStep: 50, tools: ['web_search'] });
    expect(flat.overrides).toEqual({ temperature: 0.4 });
  });

  it('lets the child win field by field', () => {
    const child: Flat = { id: 'cold', name: 'Researcher (cold)', overrides: { temperature: 0.1 }, basedOn: 'researcher' };
    const flat = flattenPack(child, [parent, child]);
    expect(flat.overrides).toEqual({ temperature: 0.1 });
    expect((flat.workspace!.run as any).maxSteps).toBe(100);
  });

  it('ignores a parent that no longer exists rather than failing the work', () => {
    const orphan: Flat = { id: 'x', name: 'Orphan', overrides: {}, basedOn: 'deleted' };
    expect(flattenPack(orphan, [orphan]).name).toBe('Orphan');
  });

  it('stops at a cycle instead of looping forever', () => {
    const a: Flat = { id: 'a', name: 'A', overrides: {}, basedOn: 'b' };
    const b: Flat = { id: 'b', name: 'B', overrides: {}, basedOn: 'a' };
    expect(flattenPack(a, [a, b]).name).toBe('A');
  });
});

describe('the container a persona runs in', () => {
  const ids = { leafId: 'leaf-1', ownerId: 'u1' };

  it('takes everything it can from the record', () => {
    const spec = personaWorkspace(
      p('Heavy', { workspace: { language: 'go', cpu: '4', memory: '8Gi', egress: [{ namespace: 'gitea', ports: [3000] }], env: [{ name: 'TOKEN', value: 'x' }] }}),
      ids,
    );
    expect(spec).toMatchObject({ leafId: 'leaf-1', ownerId: 'u1', cpu: '4', memory: '8Gi' });
    expect(spec.egress).toContainEqual({ namespace: 'gitea', ports: [3000] });
    expect(spec.env).toContainEqual({ name: 'TOKEN', value: 'x' });
    expect(spec.image).toContain('go-toolset');
  });

  it("lets the project's toolchain win over the persona's own", () => {
    const spec = personaWorkspace(p('Builder', { workspace: { language: 'node' }}), ids, { language: 'go' });
    expect(spec.image).toContain('go-toolset');
  });

  it("uses the persona's own toolchain when there is no project", () => {
    expect(personaWorkspace(p('Researcher', { workspace: { language: 'base' }}), ids).image).toContain('ubi');
  });

  it('carries no image at all when neither says', () => {
    expect(personaWorkspace(p('Plain'), ids).image).toBeUndefined();
  });

  it('distinguishes an unstated network from a deliberately closed one', () => {
    expect(personaWorkspace(p('Unstated'), ids).egress).toBeUndefined();
    expect(personaWorkspace(p('Closed', { workspace: { egress: [] }}), ids).egress).toEqual([]);
  });

  it('carries nothing extra for a persona that declares nothing', () => {
    expect(personaWorkspace(null, ids)).toEqual({ leafId: 'leaf-1', ownerId: 'u1' });
  });
});

describe('the network a checkout needs', () => {
  const ids = { leafId: 'leaf-1', ownerId: 'u' };
  const gitea = (spec: { egress?: readonly { namespace?: string | undefined; ports?: number[] | undefined }[] | undefined }) =>
    (spec.egress ?? []).find((r) => r.namespace === 'gitea');

  it('opens Gitea for a persona that works in a repository but never said so', () => {
    const spec = personaWorkspace(
      { id: 'p', ownerId: 'u', name: 'Researcher', systemPrompt: '', workspace: { repo: true } } as never,
      ids,
      { checkout: true },
    );
    expect(gitea(spec)?.ports).toContain(3000);
  });

  it('leaves a persona with no checkout unable to reach it', () => {
    const spec = personaWorkspace(
      { id: 'p', ownerId: 'u', name: 'Reviewer', systemPrompt: '', workspace: {} } as never,
      ids,
      {},
    );
    expect(gitea(spec)).toBeUndefined();
  });

  it('does not double the rule for a persona that already declared it', () => {
    const spec = personaWorkspace(
      {
        id: 'p', ownerId: 'u', name: 'Builder', systemPrompt: '',
        workspace: { repo: true, egress: [{ namespace: 'gitea', ports: [3000] }] },
      } as never,
      ids,
      { checkout: true },
    );
    expect((spec.egress ?? []).filter((r) => r.namespace === 'gitea')).toHaveLength(1);
  });
});

describe('what a workspace can install', () => {
  const spec = (language: string | undefined, scope: Record<string, unknown> = {}) =>
    personaWorkspace(
      { id: 'p', name: 'Worker', tools: [], workspace: scope } as never,
      { leafId: 'leaf-1', ownerId: 'u' },
      { language },
    );

  it('gives a python workspace pip access with no persona configuration at all', () => {
    const s = spec('python');
    expect((s.env ?? []).find((e) => e.name === 'PIP_INDEX_URL')).toBeTruthy();
    expect((s.egress ?? []).find((r) => r.namespace === 'koala-egress')?.ports).toContain(8888);
  });

  it('gives a node workspace the npm mirror instead', () => {
    const s = spec('node');
    expect((s.env ?? []).find((e) => e.name === 'NPM_CONFIG_REGISTRY')).toBeTruthy();
    expect((s.egress ?? []).find((r) => r.namespace === 'koala-egress')).toBeUndefined();
  });

  it('lets a persona override the index without ending up with two of them', () => {
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
