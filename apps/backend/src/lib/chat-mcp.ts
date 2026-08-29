import { toLoopTools, routeCall } from './mcp-tools.js';
import { wantsMcp } from './agent-run.js';
import type { McpServer } from './mcp-registry.js';
import type { PersonaPack } from '@koala/harness-types';

export interface ChatMcp {
  tools: { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }[];
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | undefined>;
  missing: string[];
}

export const NO_CHAT_MCP: ChatMcp = { tools: [], call: async () => undefined, missing: [] };

export function chatMcpFor(
  pack: Pick<PersonaPack, 'mcp'> | null | undefined,
  servers: readonly McpServer[],
  invoke: (server: McpServer, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
): ChatMcp {
  const wanted = wantsMcp(pack);
  if (!wanted.length) return NO_CHAT_MCP;

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
      const route = routeCall(name, names);
      if (!route) return undefined;
      const server = usable.find((s) => s.name === route.server);
      if (!server) return undefined;
      return invoke(server, route.tool, args);
    },
  };
}
