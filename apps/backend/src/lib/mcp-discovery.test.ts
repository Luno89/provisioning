import { describe, it, expect } from 'vitest';

import { runLeafTool, type LeafToolContext } from './tool-registry.js';
import { MemoryDB } from './memory-db.js';
import { seedTools, ALL_TOOL_SEEDS } from './tool-seeds.js';
import { PACK_SEEDS } from './pack-seeds.js';
import { schemasFor } from './tool-catalogue.js';

const LEAF_TOOLS = schemasFor(ALL_TOOL_SEEDS, PACK_SEEDS.find((p) => p.slug === 'planner')!.tools);

const seededDb = async () => {
  const db = new MemoryDB();
  await seedTools(db);
  return db as never;
};

const ctx = (db: unknown, overrides: Partial<LeafToolContext> = {}): LeafToolContext => ({
  db: db as never,
  userId: 'u1',
  branchId: 'b1',
  webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }),
  fetchWebPage: async () => '',
  projects: { listForOwner: async () => [{ id: 'p-9', name: 'github-mcp' }] } as any,
  ...overrides,
});

const call = async (registry: unknown, args = '{}') =>
  runLeafTool(
    ctx(await seededDb(), registry === undefined ? {} : { mcpRegistry: registry as any }),
    { name: 'list_mcp_servers', arguments: args },
  ).then((r) => JSON.parse(r));

describe('the tool a planner is offered', () => {
  const names = LEAF_TOOLS.map((t) => t.function.name);

  it('is list_mcp_servers', () => {
    expect(names).toContain('list_mcp_servers');
  });

  it('no longer offers the invented tool repository', () => {
    expect(names).not.toContain('list_tool_repository');
    expect(names).not.toContain('attach_tool_to_leaf');
  });

  it('says the servers are real and callable from a leaf', () => {
    const desc = LEAF_TOOLS.find((t) => t.function.name === 'list_mcp_servers')!.function.description!;
    expect(desc).toMatch(/real, running/);
    expect(desc).toMatch(/call its tools/);
    expect(desc).toMatch(/already exists/);
  });

  it('says an existing server can be extended, not just called', () => {
    const desc = LEAF_TOOLS.find((t) => t.function.name === 'list_mcp_servers')!.function.description!;
    expect(desc).toMatch(/projectId/);
    expect(desc).toMatch(/set_leaf_project/);
  });

  it('takes no owner argument', () => {
    const params: any = LEAF_TOOLS.find((t) => t.function.name === 'list_mcp_servers')!.function.parameters;
    expect(Object.keys(params.properties ?? {})).toEqual(['refresh']);
  });
});

describe('what it reports', () => {
  it('lists each server with the tools it exposes', async () => {
    const out = await call({
      listWithTools: async () => [
        { id: 'd1', name: 'github', url: 'http://x', tools: [{ name: 'create_issue', description: 'Open an issue.' }] },
      ],
    });
    expect(out.servers).toEqual([
      { name: 'github', status: 'running', tools: [{ name: 'create_issue', description: 'Open an issue.' }] },
    ]);
  });

  it('passes refresh through, so a just-deployed server is re-introspected', async () => {
    let asked: boolean | undefined;
    await call({ listWithTools: async (r: boolean) => { asked = r; return []; } }, '{"refresh":true}');
    expect(asked).toBe(true);
  });

  it('does not refresh by default', async () => {
    let asked: boolean | undefined;
    await call({ listWithTools: async (r: boolean) => { asked = r; return []; } });
    expect(asked).toBe(false);
  });

  it('keeps an unreachable server visible, with the reason', async () => {
    const out = await call({
      listWithTools: async () => [{ id: 'd1', name: 'weather', url: 'http://x', tools: [], unreachable: 'connection refused' }],
    });
    expect(out.servers[0].status).toBe('unreachable');
    expect(out.servers[0].unreachable).toBe('connection refused');
  });
});

describe('changing a server rather than calling it', () => {
  const withProject = {
    listWithTools: async () => [
      { id: 'd1', name: 'github-mcp', url: 'http://x', tools: [{ name: 'get_repo' }], projectId: 'p-9' },
    ],
  };

  it('reports the project the server is built from', async () => {
    const out = await call(withProject);
    expect(out.servers[0].projectId).toBe('p-9');
  });

  it('tells the planner what to DO with it', async () => {
    const out = await call(withProject);
    expect(out.note).toMatch(/set_leaf_project/);
    expect(out.note).toMatch(/rebuilds and redeploys/);
  });

  it('resolves the project NAME when it can', async () => {
    expect((await call(withProject)).servers[0].projectName).toBe('github-mcp');
  });

  it('still reports the server when the project lookup fails outright', async () => {
    const out = await runLeafTool(
      ctx(await seededDb(), { mcpRegistry: withProject as any, projects: {} as any }),
      { name: 'list_mcp_servers', arguments: '{}' },
    ).then((r) => JSON.parse(r));
    expect(out.servers[0].projectId).toBe('p-9');
    expect(out.servers[0].projectName).toBeUndefined();
  });

  it('says nothing about editing when no server has a repository', async () => {
    const out = await call({ listWithTools: async () => [{ id: 'd1', name: 'external', url: 'http://x', tools: [] }] });
    expect(out.servers[0].projectId).toBeUndefined();
    expect(out.note).toBeUndefined();
  });
});

describe('the two kinds of nothing, which must not read alike', () => {
  it('says none are deployed, and what to do about it', async () => {
    const out = await call({ listWithTools: async () => [] });
    expect(out.servers).toEqual([]);
    expect(out.note).toMatch(/No MCP servers are deployed/);
  });

  it('says so when it CANNOT see, rather than reporting an empty list', async () => {
    const out = await call(undefined);
    expect(out.servers).toBeUndefined();
    expect(out.error).toMatch(/not available/);
    expect(out.error).toMatch(/Do not conclude there are none/);
  });
});
