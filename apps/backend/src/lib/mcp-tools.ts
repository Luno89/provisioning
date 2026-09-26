import type { ToolContract } from '@koala/engine-core';
import type { McpServer } from './mcp-registry.js';
import type { McpTool } from './mcp-client.js';

export const SEPARATOR = '__';

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'server';
}

export const qualify = (server: string, tool: string): string => `${slugify(server)}${SEPARATOR}${tool}`;

export function unqualify(name: string): { server: string; tool: string } | undefined {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0) return undefined;
  const tool = name.slice(at + SEPARATOR.length);
  return tool ? { server: name.slice(0, at), tool } : undefined;
}

export const isMcpToolName = (name: string): boolean => unqualify(name) !== undefined;

export function contractFor(server: string, tool: McpTool): ToolContract {
  const hints = tool.annotations ?? {};
  return {
    name: qualify(server, tool.name),
    description: `[${server}] ${tool.description?.trim() || `The ${tool.name} tool.`}`,
    binding: 'network',
    effect: hints.readOnlyHint === true ? 'read' : 'write',
    idempotent: hints.idempotentHint === true,
    openWorld: hints.openWorldHint !== false,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}

export function contractsFor(servers: readonly McpServer[]): ToolContract[] {
  const seen = new Set<string>();
  const out: ToolContract[] = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      if (!tool?.name) continue;
      const contract = contractFor(server.name, tool);
      if (seen.has(contract.name)) continue;
      seen.add(contract.name);
      out.push(contract);
    }
  }
  return out;
}

export function serversFor(wanted: readonly string[], available: readonly McpServer[]): McpServer[] {
  const names = new Set(wanted);
  return available.filter((server) => names.has(server.name) && !server.unreachable && server.tools.length > 0);
}

export function routeCall(name: string, servers: readonly McpServer[]): { server: McpServer; tool: string } | undefined {
  const parsed = unqualify(name);
  if (!parsed) return undefined;
  const server = servers.find((candidate) => slugify(candidate.name) === parsed.server);
  if (!server || !server.tools.some((tool) => tool.name === parsed.tool)) return undefined;
  return { server, tool: parsed.tool };
}
