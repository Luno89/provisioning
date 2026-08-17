/**
 * Turning an MCP server's tools into tools the agent loop can call.
 *
 * ── WHY NAMESPACING IS NOT OPTIONAL ──
 * Two servers Koala builds will both have a `search`. A server will have a `run_command`. The loop
 * already ships `run_command`, `write_file` and `finish`, and a collision does not error — the
 * model simply calls one thing and gets another, which is the worst possible failure because it
 * looks like the tool misbehaved.
 *
 * So every remote tool is prefixed with the server it came from, and `finish` in particular can
 * never be shadowed: a server that shadowed it could end runs.
 *
 * ── AND WHY THE SCHEMA IS PASSED THROUGH, NOT REWRITTEN ──
 * The server's `inputSchema` is already JSON Schema, which is what the tools API wants. Rewriting
 * it would mean maintaining a translation for every JSON Schema feature a server might use, and
 * getting one wrong shows up as a model that cannot call a tool for reasons nobody can see. A
 * missing schema becomes an open object rather than a guess.
 */
import type { McpTool } from './mcp-client.js';

/** Separates the server from the tool. Double underscore because tool names may contain one. */
export const NAMESPACE_SEPARATOR = '__';

/** Names the harness owns. A remote tool may never take one of these. */
export const RESERVED_TOOL_NAMES = ['finish', 'run_command', 'write_file', 'read_file', 'search_web'];

/**
 * A server name reduced to something a tool name can contain.
 *
 * The tools API accepts `^[a-zA-Z0-9_-]+$`; a deployment called "weather api (staging)" is a
 * perfectly ordinary name and an invalid tool prefix, and the resulting 400 says nothing useful.
 */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'server';
}

export function qualify(server: string, tool: string): string {
  return `${slugify(server)}${NAMESPACE_SEPARATOR}${tool}`;
}

/** The reverse. `undefined` for a name that was never ours, so built-ins fall through untouched. */
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

/**
 * One server's tools, in the shape the loop sends.
 *
 * The description says which server a tool belongs to. Without it a model faced with
 * `weather__get-forecast` and `github__search` has only the prefix to go on, and prefixes are
 * exactly what models paraphrase away when they get creative.
 */
export function toLoopTools(server: string, tools: McpTool[]): LoopTool[] {
  const seen = new Set<string>();
  const out: LoopTool[] = [];

  for (const tool of tools) {
    if (!tool?.name) continue;
    const name = qualify(server, tool.name);

    // A remote tool that lands on a harness name would shadow it. Skipped rather than renamed:
    // silently answering to a different name is how a model calls `finish` and something else runs.
    if (RESERVED_TOOL_NAMES.includes(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      type: 'function',
      function: {
        name,
        description: `[${server}] ${tool.description ?? `The ${tool.name} tool.`}`,
        // Passed through. A missing schema becomes an open object rather than a guess about what
        // the server wants.
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    });
  }

  return out;
}

/**
 * Which server a call belongs to, given the servers currently offered.
 *
 * Matched against the KNOWN servers rather than by splitting on the separator alone: a built-in
 * tool whose name happens to contain a double underscore would otherwise be routed to a server
 * that does not exist, and the model would be told its own tool is missing.
 */
export function routeCall(
  qualified: string,
  servers: string[],
): { server: string; tool: string } | undefined {
  const parsed = unqualify(qualified);
  if (!parsed) return undefined;
  const match = servers.find((s) => slugify(s) === parsed.server);
  return match ? { server: match, tool: parsed.tool } : undefined;
}
