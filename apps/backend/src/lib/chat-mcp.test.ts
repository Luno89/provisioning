import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chatMcpFor, NO_CHAT_MCP } from './chat-mcp.js';
import { preferUsable } from './mcp-registry.js';
import { validateScope } from './personas.js';

/**
 * The persona you are TALKING TO calling an MCP server.
 *
 * ── WHAT DECIDED THIS BEFORE ──
 * Nothing. The chat route sent `tools: LEAF_TOOLS`, a hardcoded array, at every request site.
 * `persona.scope.mcp` was read only by ExecuteLeafActivity, so a persona could be handed a server's
 * tools when it ran a LEAF and got the board tools and nothing else in conversation.
 *
 * `list_mcp_servers` closed half of it — the chat model could SEE what was deployed. It still could
 * not call any of it: it could tell you `github-mcp` exposes `github-get-repo` and had no way to
 * look up a repository.
 */

const server = (over: Partial<any> = {}) => ({
  id: 'd1', name: 'github-mcp', url: 'http://x',
  tools: [{ name: 'get-repo', description: 'Look up a repo.' }],
  ...over,
});
const invoke = async () => ({ text: 'ok', isError: false });

describe('what the persona is granted', () => {
  it('offers the tools of a server it named', () => {
    const got = chatMcpFor({ scope: { mcp: ['github-mcp'] } } as any, [server()], invoke);
    expect(got.tools).toHaveLength(1);
    expect(got.tools[0]!.function.name).toContain('get-repo');
  });

  it('grants NOTHING when the persona named nothing', () => {
    /**
     * The deliberate choice. Handing every running server to every conversation costs prompt tokens
     * on every message of every chat, and a persona is already the unit that means "what this agent
     * may reach" everywhere else — egress, toolchain, budget.
     */
    expect(chatMcpFor({ scope: {} } as any, [server()], invoke)).toBe(NO_CHAT_MCP);
    expect(chatMcpFor(null, [server()], invoke)).toBe(NO_CHAT_MCP);
  });

  it('grants only what was named, not every server running', () => {
    const got = chatMcpFor(
      { scope: { mcp: ['github-mcp'] } } as any,
      [server(), server({ id: 'd2', name: 'weather', tools: [{ name: 'forecast' }] })],
      invoke,
    );
    expect(got.tools.map((t) => t.function.name).join()).toContain('github-mcp');
    expect(got.tools.map((t) => t.function.name).join()).not.toContain('weather');
  });
});

describe('servers that cannot answer', () => {
  it('drops an unreachable one and reports it', () => {
    // Offering a tool that cannot answer spends a round trip producing an error the model then has
    // to reason about — worse than not offering it.
    const got = chatMcpFor(
      { scope: { mcp: ['github-mcp'] } } as any,
      [server({ unreachable: 'connection refused' })],
      invoke,
    );
    expect(got.tools).toHaveLength(0);
    expect(got.missing).toEqual(['github-mcp']);
  });

  it('drops one with no tools, and one that is not running at all', () => {
    expect(chatMcpFor({ scope: { mcp: ['github-mcp'] } } as any, [server({ tools: [] })], invoke).missing)
      .toEqual(['github-mcp']);
    expect(chatMcpFor({ scope: { mcp: ['gone'] } } as any, [server()], invoke).missing).toEqual(['gone']);
  });
});

describe('two deployments answering to one name', () => {
  /**
   * Observed the moment a second run redeployed the same service: `github-mcp` appeared twice, one
   * with three tools and one returning `HTTP 404 from initialize`. A Map keyed by name is
   * last-one-wins, so the broken copy replaced the working one and the persona was told its server
   * did not exist.
   */
  it('uses the copy that answers, whichever order they arrive in', () => {
    const broken = server({ id: 'd2', tools: [], unreachable: 'HTTP 404 from initialize' });
    for (const list of [[server(), broken], [broken, server()]]) {
      const got = chatMcpFor({ scope: { mcp: ['github-mcp'] } } as any, list, invoke);
      expect(got.tools).toHaveLength(1);
      expect(got.missing).toEqual([]);
    }
  });

  it('still reports missing when EVERY copy is broken', () => {
    const got = chatMcpFor(
      { scope: { mcp: ['github-mcp'] } } as any,
      [server({ tools: [], unreachable: 'a' }), server({ id: 'd2', tools: [], unreachable: 'b' })],
      invoke,
    );
    expect(got.missing).toEqual(['github-mcp']);
  });
});

describe('collapsing two deployments with one name', () => {
  const broken = server({ id: 'd2', tools: [], unreachable: 'HTTP 404 from initialize' });

  it('keeps one entry per name, whichever order they arrive in', () => {
    for (const list of [[server(), broken], [broken, server()]]) {
      const out = preferUsable(list);
      expect(out).toHaveLength(1);
      expect(out[0]!.tools).toHaveLength(1);
    }
  });

  it('still returns the broken one when it is the ONLY copy', () => {
    // Dropping it would report a deployed-but-broken service as simply absent.
    const out = preferUsable([broken]);
    expect(out).toHaveLength(1);
    expect(out[0]!.unreachable).toBeTruthy();
  });

  it('leaves distinct names alone', () => {
    expect(preferUsable([server(), server({ id: 'd3', name: 'weather' })])).toHaveLength(2);
  });
});

describe('routing a call', () => {
  const got = () => chatMcpFor({ scope: { mcp: ['github-mcp'] } } as any, [server()], invoke);

  it('runs a qualified remote name', async () => {
    const name = got().tools[0]!.function.name;
    await expect(got().call(name, {})).resolves.toEqual({ text: 'ok', isError: false });
  });

  it('REFUSES a board tool name, so it cannot be swallowed', async () => {
    /**
     * Load-bearing: the route checks remote FIRST, which is only safe because this returns
     * undefined for anything that is not `server__tool` for a granted server. The executor's loop
     * had exactly this ordering bug, caught by a test — trying remote before built-in let a handler
     * shadow `run_command`.
     */
    for (const n of ['propose_leaf', 'list_mcp_servers', 'set_acceptance', 'run_command']) {
      await expect(got().call(n, {}), n).resolves.toBeUndefined();
    }
  });

  it('refuses a tool qualified with a server that was not granted', async () => {
    await expect(got().call('weather__forecast', {})).resolves.toBeUndefined();
  });
});

describe('scope.mcp is a validated field now', () => {
  it('accepts a list of names', () => {
    expect(validateScope({ mcp: ['github-mcp'] })).toBeUndefined();
    expect(validateScope({})).toBeUndefined();
  });

  it('rejects shapes that would fail later, in a sandbox', () => {
    // It was accepted unvalidated because only the executor read it and nobody set it by hand.
    expect(validateScope({ mcp: 'github-mcp' })).toMatch(/list of MCP server names/);
    expect(validateScope({ mcp: [1] })).toBeTruthy();
    expect(validateScope({ mcp: ['  '] })).toBeTruthy();
  });
});

describe('how the route uses it', () => {
  /**
   * Reads `routes/chat.ts` rather than `index.ts`: the handler moved there when the route was
   * extracted, and this assertion is against its SOURCE TEXT, so a stale path makes the test pass
   * against a file that no longer contains the code.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(join(here, '../routes/chat.ts'), 'utf8');

  it('sends the granted tools at every request site, not LEAF_TOOLS', () => {
    // Three sites. One left on the constant is a turn where the model loses its tools mid-thought.
    expect(route).toMatch(/\.\.\.\(offerTools \? \{ tools: turnTools \} : \{\}\)/);
    expect(route).toMatch(/tools: turnTools,\s*\n\s*stream: true,/);
  });

  it('resolves once per turn rather than per round', () => {
    // A turn can take eight rounds, and each listing is a database read plus a NodePort lookup.
    const decl = route.indexOf('let chatMcp = NO_CHAT_MCP;');
    const loop = route.indexOf('for (let round = 0; round < MAX_TOOL_ROUNDS');
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(loop);
  });

  it('never fails the conversation over the registry', () => {
    // A chat that dies because a service the user did not ask about is down.
    const at = route.indexOf('could not resolve MCP tools for this turn');
    expect(at).toBeGreaterThan(-1);
  });
});
