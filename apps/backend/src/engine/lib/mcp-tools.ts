import type { ToolContract } from '@koala/engine-core';
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
    destructive: hints.readOnlyHint !== true && hints.destructiveHint !== false,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}
