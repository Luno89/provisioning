import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chatMcpFor, NO_CHAT_MCP } from './chat-mcp.js';
import { preferUsable } from './mcp-registry.js';
import { validateScope } from './personas.js';

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
    expect(validateScope({ mcp: 'github-mcp' })).toMatch(/list of MCP server names/);
    expect(validateScope({ mcp: [1] })).toBeTruthy();
    expect(validateScope({ mcp: ['  '] })).toBeTruthy();
  });
});

describe('how the route uses it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(join(here, '../routes/chat.ts'), 'utf8');

  it('sends the granted tools at every request site, not LEAF_TOOLS', () => {
    expect(route).toMatch(/\.\.\.\(offerTools \? \{ tools: turnTools \} : \{\}\)/);
    expect(route).toMatch(/tools: turnTools,\s*\n\s*stream: true,/);
  });

  it('resolves once per turn rather than per round', () => {
    const decl = route.indexOf('let chatMcp = NO_CHAT_MCP;');
    const loop = route.indexOf('for (let round = 0; round < MAX_TOOL_ROUNDS');
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(loop);
  });

  it('never fails the conversation over the registry', () => {
    const at = route.indexOf('could not resolve MCP tools for this turn');
    expect(at).toBeGreaterThan(-1);
  });
});
