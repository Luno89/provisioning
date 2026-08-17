import { toLoopTools, routeCall } from './mcp-tools.js';
import { wantsMcp } from './agent-run.js';
import type { McpServer } from './mcp-registry.js';
import type { Persona } from './personas.js';

/**
 * Letting the persona you are TALKING TO call an MCP server.
 *
 * ── WHAT DECIDED THIS BEFORE ──
 * Nothing. The chat route sent `tools: LEAF_TOOLS`, a hardcoded array, at all three of its request
 * sites. `persona.scope.mcp` was read only by `ExecuteLeafActivity`, so a persona could name a
 * server and be handed its tools when it ran a LEAF, while the same persona in conversation got
 * the board tools and nothing else.
 *
 * `list_mcp_servers` closed half of that: the chat model can now SEE what is deployed. It still
 * could not call any of it — it could tell you `github-mcp` exposes `github-get-repo` and then had
 * no way to look up a repository.
 *
 * ── WHY IT IS STILL THE PERSONA THAT DECIDES ──
 * Handing every running server to every conversation was the obvious alternative and is wrong on
 * two counts. Every tool costs prompt tokens on every message of every chat, so a user with ten
 * services would pay for all of them to ask a question about none. And a persona is the unit that
 * already means "what this agent may reach" everywhere else in this codebase — egress, toolchain,
 * time budget. Making chat the one place that ignores it would be a second answer to a question
 * that already has one.
 *
 * A leaf can name servers its persona did not, because the leaf is the first thing that exists
 * after a server is built. A conversation has no such excuse: the persona is editable, and naming
 * the server there is the deliberate act that grants it.
 */

export interface ChatMcp {
  /** Appended to LEAF_TOOLS for this turn. Empty when the persona named nothing usable. */
  tools: { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }[];
  /** Runs a qualified remote call, or returns undefined when the name is not one of these. */
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | undefined>;
  /** Names the persona asked for that are not running — worth saying, never worth failing over. */
  missing: string[];
}

/** Nothing granted. Kept as a value so callers never branch on undefined. */
export const NO_CHAT_MCP: ChatMcp = { tools: [], call: async () => undefined, missing: [] };

/**
 * The MCP tools a chat turn should be offered, and how to run them.
 *
 * `servers` is what the registry reported. Unreachable ones and ones with no tools are dropped:
 * offering a tool that cannot answer spends a round trip to produce an error the model then has to
 * reason about, which is worse than not offering it.
 */
export function chatMcpFor(
  persona: Pick<Persona, 'scope'> | null | undefined,
  servers: readonly McpServer[],
  invoke: (server: McpServer, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
): ChatMcp {
  const wanted = wantsMcp(persona);
  if (!wanted.length) return NO_CHAT_MCP;

  /**
   * Two deployments can answer to one name, and the healthy one must win.
   *
   * Observed the moment a second run redeployed the same service: `github-mcp` appeared twice, one
   * with three tools and one returning `HTTP 404 from initialize`. A `Map` keyed by name is
   * last-one-wins, so the broken copy silently replaced the working one and the persona was told
   * its server did not exist.
   *
   * Picking the usable one is not papering over that — a stale deployment lingering under a live
   * name is a real problem worth seeing elsewhere — but a conversation should use the copy that
   * answers, not the copy that happens to sort last.
   */
  const pick = (name: string): McpServer | undefined => {
    const matches = servers.filter((s) => s.name === name);
    return matches.find((s) => s.tools.length && !s.unreachable) ?? matches[0];
  };

  const chosen = wanted.map((name) => ({ name, server: pick(name) }));
  const usable = chosen
    .map((c) => c.server)
    .filter((s): s is McpServer => Boolean(s && s.tools.length && !s.unreachable));
  const missing = chosen
    .filter((c) => !c.server || !c.server.tools.length || Boolean(c.server.unreachable))
    .map((c) => c.name);

  if (!usable.length) return { ...NO_CHAT_MCP, missing };

  const names = usable.map((s) => s.name);
  return {
    tools: usable.flatMap((s) => toLoopTools(s.name, s.tools)) as ChatMcp['tools'],
    missing,
    call: async (name, args) => {
      // `routeCall` splits the qualified name and refuses anything not belonging to these servers,
      // which is what keeps a board tool from being dispatched down here by a colliding name.
      const route = routeCall(name, names);
      if (!route) return undefined;
      // The copy chosen above, so a call cannot land on the broken twin.
      const server = usable.find((s) => s.name === route.server);
      if (!server) return undefined;
      return invoke(server, route.tool, args);
    },
  };
}
