import { describe, it, expect, vi } from 'vitest';
import { baseFor, languagesFor, type AgentDefinition } from '@koala/agent-engine';
import { mergeWorkspaceAgents, type EnvironmentResolver } from './environments.js';
import { createTreeWorkspaces } from './tree-workspaces.js';
import { treeLanguageFrom, type TreeTypeSpec } from '../../lib/tree-types.js';
import { WORKSPACE_BASES } from '../../extensions/workspace-bases.js';

const agent = (slug: string, over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  slug, name: slug, prompt: '', tools: [`${slug}_tool`], procedure: 'tool-rounds',
  environment: { kind: 'sandbox', terminal: true, filesystem: true },
  ...over,
} as AgentDefinition);

describe('the image a shared workspace gets', () => {
  it('puts the languages it is asked for first, and every agent\'s after them, even when one declares a spec', () => {
    const merged = mergeWorkspaceAgents([
      agent('executor', { environmentSpec: { kind: 'sandbox', lifecycle: 'invocation', languages: ['node'] } as never }),
      agent('judge', { environment: { terminal: true, languages: ['python'] } as never }),
    ], 'grove-runner', ['odoo'])!;

    expect(languagesFor(merged)).toEqual(['odoo', 'node', 'python']);
    expect(baseFor(merged, WORKSPACE_BASES)).toBe('odoo');
    expect(merged.tools).toEqual(['executor_tool', 'judge_tool']);
  });
});

describe('a tree\'s workspace', () => {
  const types = [{ id: 'odoo-addons', language: 'odoo' }, { id: 'mine', language: 'python', ownerId: 'bo' }] as TreeTypeSpec[];
  const store = {
    getTrees: async () => [{ id: 't1', ownerId: 'bo', type: 'odoo-addons' }, { id: 't2', ownerId: 'bo', type: 'mine' }, { id: 't3', ownerId: 'bo' }],
    getTreeTypes: async () => types,
  };

  it('works in the language its type names, and in none when it has no type', async () => {
    const languageOf = treeLanguageFrom(store);
    expect(await languageOf('bo', 't1')).toBe('odoo');
    expect(await languageOf('bo', 't2')).toBe('python');
    expect(await languageOf('bo', 't3')).toBeUndefined();
    expect(await languageOf('cy', 't1')).toBeUndefined();
  });

  it('asks for that language when it describes the shared workspace', async () => {
    const describeShared = vi.fn(async (_request: { languages?: string[] | undefined }) => ({}) as never);
    const workspaces = createTreeWorkspaces({ resolver: { describeShared } as unknown as EnvironmentResolver, kube: vi.fn() as never, languageOf: treeLanguageFrom(store) });
    await workspaces.describe({ treeId: 't1', ownerId: 'bo' });
    await workspaces.describe({ treeId: 't3', ownerId: 'bo' });
    expect(describeShared.mock.calls.map(([request]) => request.languages)).toEqual([['odoo'], undefined]);
  });
});

describe('the Odoo workspace\'s own environment', () => {
  it('rides in the image plan, so every workspace built from it can find the browser', async () => {
    const { planWorkspace } = await import('../../extensions/workspace-bases.js');
    const plan = planWorkspace(agent('executor', { environmentSpec: { kind: 'sandbox', lifecycle: 'invocation', languages: ['odoo'] } as never }), [])!;
    expect(plan.env).toEqual([{ name: 'PLAYWRIGHT_BROWSERS_PATH', value: '/ms-playwright' }, { name: 'NODE_PATH', value: '/usr/local/lib/node_modules' }]);
  });

  it('reaches the workspace pod next to what its tools need', async () => {
    const { workspaceFor } = await import('./environments.js');
    const workspace = await workspaceFor({
      runId: 'run-1', ownerId: 'bo', egressMode: 'declared', tools: [],
      agent: agent('executor', { environmentSpec: { kind: 'sandbox', lifecycle: 'invocation', languages: ['odoo'] } as never }),
      images: { ensure: async () => 'reg/workspace:x' } as never,
    });
    expect(workspace.env).toEqual(expect.arrayContaining([{ name: 'PLAYWRIGHT_BROWSERS_PATH', value: '/ms-playwright' }, { name: 'NPM_CONFIG_REGISTRY', value: expect.any(String) }]));
  });
});
