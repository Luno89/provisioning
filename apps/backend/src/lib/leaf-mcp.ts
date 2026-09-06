import type { PersonaPack, PersonaEgressRule } from '@koala/harness-types';
import type { Leaf } from './leaves.js';
import { resolveForPersona, mcpGaps, type McpServer, type EgressRule } from './mcp-registry.js';
import { toLoopTools, routeCall } from './mcp-tools.js';
import { wantsMcp } from './agent-run.js';

export interface McpRegistryAccess {
  listWithTools(): Promise<McpServer[]>;
  call(server: McpServer, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export async function resolveMcpForLeaf(
  deps: { registry: McpRegistryAccess },
  pack: Pick<PersonaPack, 'mcp'> | undefined,
  leaf: Pick<Leaf, 'id' | 'mcp'>,
  egress: PersonaEgressRule[] | undefined,
): Promise<Record<string, unknown>> {
  const wanted = [...new Set([...wantsMcp(pack), ...(leaf.mcp ?? [])])];
  if (!wanted.length) return {};

  try {
    const { servers, missing } = resolveForPersona(wanted, await deps.registry.listWithTools());

    if (missing.length) {
      console.warn(`[leaf-mcp] leaf ${leaf.id}: pack named MCP servers that are not running — ${missing.join(', ')}`);
    }
    for (const gap of mcpGaps(servers, egress as EgressRule[] | undefined, (s) => s.deploymentName ?? s.name)) {
      console.warn(`[leaf-mcp] leaf ${leaf.id}: ${gap}`);
    }

    const usable = servers.filter((s) => s.tools.length && !s.unreachable);
    if (!usable.length) return {};

    const remoteTools = usable.flatMap((s) => toLoopTools(s.name, s.tools));
    return {
      remoteTools,
      remoteToolNames: remoteTools.map((t) => t.function.name),
      callRemote: async (name: string, args: Record<string, unknown>) => {
        const route = routeCall(name, usable.map((s) => s.name));
        const server = route ? usable.find((s) => s.name === route.server) : undefined;
        if (!route || !server) return undefined;
        return deps.registry.call(server, route.tool, args);
      },
    };
  } catch (err: any) {
    console.warn(`[leaf-mcp] leaf ${leaf.id}: could not resolve MCP servers — ${String(err?.message ?? err).slice(0, 200)}`);
    return {};
  }
}
