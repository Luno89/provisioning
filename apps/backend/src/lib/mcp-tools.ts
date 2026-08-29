import type { McpTool } from './mcp-client.js';

export const NAMESPACE_SEPARATOR = '__';

export const RESERVED_TOOL_NAMES = ['finish', 'run_command', 'write_file', 'read_file', 'search_web'];

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'server';
}

export function qualify(server: string, tool: string): string {
  return `${slugify(server)}${NAMESPACE_SEPARATOR}${tool}`;
}

export function unqualify(qualified: string): { server: string; tool: string } | undefined {
  const at = qualified.indexOf(NAMESPACE_SEPARATOR);
  if (at <= 0) return undefined;
  const tool = qualified.slice(at + NAMESPACE_SEPARATOR.length);
  if (!tool) return undefined;
  return { server: qualified.slice(0, at), tool };
}

export interface LoopTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toLoopTools(server: string, tools: McpTool[]): LoopTool[] {
  const seen = new Set<string>();
  const out: LoopTool[] = [];

  for (const tool of tools) {
    if (!tool?.name) continue;
    const name = qualify(server, tool.name);

    if (RESERVED_TOOL_NAMES.includes(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      type: 'function',
      function: {
        name,
        description: `[${server}] ${tool.description ?? `The ${tool.name} tool.`}`,
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    });
  }

  return out;
}

export function routeCall(
  qualified: string,
  servers: string[],
): { server: string; tool: string } | undefined {
  const parsed = unqualify(qualified);
  if (!parsed) return undefined;
  const match = servers.find((s) => slugify(s) === parsed.server);
  return match ? { server: match, tool: parsed.tool } : undefined;
}
