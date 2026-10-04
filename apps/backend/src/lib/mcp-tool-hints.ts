import type { McpToolAnnotations } from './mcp-client.js';
import type { McpServer } from './mcp-registry.js';

export const HINT_CHOICES = ['server', 'read-only', 'safe-write', 'destructive'] as const;
export type HintChoice = (typeof HINT_CHOICES)[number];

export interface McpToolHint {
  ownerId: string;
  server: string;
  tool: string;
  choice: Exclude<HintChoice, 'server'>;
  updatedAt: string;
}

export const hintKey = (ownerId: string, server: string, tool: string): string => `${ownerId}:${server}:${tool}`;

export function overriddenAnnotations(declared: McpToolAnnotations | undefined, choice: HintChoice | undefined): McpToolAnnotations | undefined {
  if (!choice || choice === 'server') return declared;
  if (choice === 'read-only') return { ...declared, readOnlyHint: true, destructiveHint: false };
  return { ...declared, readOnlyHint: false, destructiveHint: choice === 'destructive' };
}

export function withHints(servers: readonly McpServer[], hints: readonly McpToolHint[]): McpServer[] {
  const chosen = new Map(hints.map((hint) => [`${hint.server}:${hint.tool}`, hint.choice]));
  return servers.map((server) => ({
    ...server,
    tools: server.tools.map((tool) => {
      const choice = chosen.get(`${server.name}:${tool.name}`);
      if (!choice) return tool;
      const annotations = overriddenAnnotations(tool.annotations, choice);
      return { ...tool, ...(annotations ? { annotations } : {}), declared: tool.annotations ?? {}, choice };
    }),
  }));
}
