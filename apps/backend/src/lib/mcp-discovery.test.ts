import { describe, it, expect } from 'vitest';
import { LEAF_TOOLS } from './leaf-tools.js';
import { runLeafTool, type LeafToolContext } from './leaf-tool-runner.js';
import { MemoryDB } from './memory-db.js';

/**
 * How a planning turn finds out which MCP servers exist.
 *
 * ── THE GAP THIS CLOSES ──
 * Asked what MCP servers it could use, Koala did not say "I don't know" — it gave a confident wrong
 * answer, because `list_tool_repository` returned six hardcoded strings (`pytest_runner`,
 * `git_inspector`, `linter_audit`…) that no sandbox has ever had, and `attach_tool_to_leaf` wrote
 * the chosen id to `leaf.attachedTools`, a field NOTHING reads. Discovery was a closed loop of
 * fiction sitting exactly where the real thing should have been.
 *
 * The registry existed and worked the whole time — it was wired only into ExecuteLeafActivity, so
 * the agent RUNNING a leaf could call a server while the planner deciding what to build could not
 * see one.
 */

const ctx = (overrides: Partial<LeafToolContext> = {}): LeafToolContext => ({
  db: new MemoryDB() as any,
  userId: 'u1',
  branchId: 'b1',
  webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }),
  fetchWebPage: async () => '',
  // Real enough to resolve a project name; the runner must also survive it failing.
  projects: { listForOwner: async () => [{ id: 'p-9', name: 'github-mcp' }] } as any,
  ...overrides,
});

const call = (registry: unknown, args = '{}') =>
  runLeafTool(
    ctx(registry === undefined ? {} : { mcpRegistry: registry as any }),
    { name: 'list_mcp_servers', arguments: args },
  ).then((r) => JSON.parse(r));

describe('the tool a planner is offered', () => {
  const names = LEAF_TOOLS.map((t) => t.function.name);

  it('is list_mcp_servers', () => {
    expect(names).toContain('list_mcp_servers');
  });

  it('no longer offers the invented tool repository', () => {
    // Leaving it alongside the real one would keep the confident wrong answer available.
    expect(names).not.toContain('list_tool_repository');
    expect(names).not.toContain('attach_tool_to_leaf');
  });

  it('says the servers are real and callable from a leaf', () => {
    /**
     * The description is the only place a model learns that building a server makes it usable
     * later. Without that it discovers a list and draws no conclusion from it.
     */
    const desc = LEAF_TOOLS.find((t) => t.function.name === 'list_mcp_servers')!.function.description!;
    expect(desc).toMatch(/real, running/);
    expect(desc).toMatch(/call its tools/);
    expect(desc).toMatch(/already exists/);
  });

  it('says an existing server can be extended, not just called', () => {
    // The half that decides whether "add a tool to github-mcp" edits the repo or builds a rival.
    const desc = LEAF_TOOLS.find((t) => t.function.name === 'list_mcp_servers')!.function.description!;
    expect(desc).toMatch(/projectId/);
    expect(desc).toMatch(/set_leaf_project/);
  });

  it('takes no owner argument', () => {
    // Ownership comes from the session. A prompt that could name one reaches across tenants.
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
    // Introspecting every server on every planning turn would make each one a round of HTTP calls.
    let asked: boolean | undefined;
    await call({ listWithTools: async (r: boolean) => { asked = r; return []; } });
    expect(asked).toBe(false);
  });

  it('keeps an unreachable server visible, with the reason', async () => {
    /**
     * Dropping it would report a deployed-but-broken server as simply absent, and the planner would
     * propose building a second copy of something already there.
     */
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
    /**
     * The link was in the data as `gitappProjectId` the whole time and was never handed to anything
     * that plans — so a planner could see that github-mcp exposes three tools and still had no way
     * to add a fourth.
     */
    const out = await call(withProject);
    expect(out.servers[0].projectId).toBe('p-9');
  });

  it('tells the planner what to DO with it', async () => {
    // A project id with no instruction is a field nobody uses.
    const out = await call(withProject);
    expect(out.note).toMatch(/set_leaf_project/);
    expect(out.note).toMatch(/rebuilds and redeploys/);
  });

  it('resolves the project NAME when it can', async () => {
    expect((await call(withProject)).servers[0].projectName).toBe('github-mcp');
  });

  it('still reports the server when the project lookup fails outright', async () => {
    // The id is what set_leaf_project needs; the name is a convenience. Losing the convenience must
    // not lose the server — and a missing dependency throws synchronously, which no .catch sees.
    const out = await runLeafTool(
      ctx({ mcpRegistry: withProject as any, projects: {} as any }),
      { name: 'list_mcp_servers', arguments: '{}' },
    ).then((r) => JSON.parse(r));
    expect(out.servers[0].projectId).toBe('p-9');
    expect(out.servers[0].projectName).toBeUndefined();
  });

  it('says nothing about editing when no server has a repository', async () => {
    // A discovered server nobody here builds cannot be edited, and saying so would be a dead end.
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
    /**
     * The distinction the whole tool turns on. "None exist" and "I cannot tell" lead a planner to
     * opposite decisions — one builds the server, the other rebuilds one that is already running.
     */
    const out = await call(undefined);
    expect(out.servers).toBeUndefined();
    expect(out.error).toMatch(/not available/);
    expect(out.error).toMatch(/Do not conclude there are none/);
  });
});
