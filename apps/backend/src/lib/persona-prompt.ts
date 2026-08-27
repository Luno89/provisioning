/**
 * persona-prompt.ts — Universal, context-aware prompt composer for any persona.
 *
 * ── DESIGN PRINCIPLES ──
 * 1. "Any persona that gets a tool should get the context about the tool."
 *    When tools are granted or enabled, actionable workflow guidance is dynamically injected.
 * 2. Context-Budget Sizing:
 *    Calculates context pressure against the window. Low pressure yields rich multi-line
 *    guidance; moderate pressure yields compact 1-line guidance; high pressure yields minimal
 *    directives to avoid triggering premature handoffs or window overflow.
 * 3. Role & Privilege Transparency:
 *    Injects Administrator status, active escalation grants, or guidance to call
 *    `request_escalated_privileges` when elevated cluster access is required.
 */

import { contextPressure, FALLBACK_CONTEXT_TOKENS } from './sampling.js';
import { TOOL_SEEDS, type ToolRepositoryItem } from './tool-seeds.js';

export interface McpServerItem {
  name: string;
  description?: string;
  tools?: readonly { name: string; description?: string }[];
}

export interface PersonaPromptOptions {
  activeTools?: readonly string[] | undefined;
  toolRegistry?: readonly ToolRepositoryItem[] | undefined;
  servers?: readonly McpServerItem[] | undefined;
  enabledServers?: readonly string[] | undefined;
  historyChars?: number | undefined;
  maxContextTokens?: number | undefined;
  isAdmin?: boolean | undefined;
  isEscalated?: boolean | undefined;
  escalatedNamespaces?: readonly string[] | undefined;
  memoryContext?: string | undefined;
}

/**
 * Universal prompt composer for any persona.
 */
export function composePersonaPrompt(
  basePrompt: string,
  options?: PersonaPromptOptions,
): string {
  const sections: string[] = [basePrompt.trim()];
  const historyChars = options?.historyChars ?? 0;
  const maxTokens = options?.maxContextTokens ?? FALLBACK_CONTEXT_TOKENS;
  const pressure = contextPressure(basePrompt.length + historyChars, maxTokens);

  // 1. Role & Privilege State
  if (options?.isAdmin) {
    sections.push(
      '## Platform Role: Administrator\n'
      + 'You are interacting with a cluster Administrator. You have cluster-wide visibility across all namespaces, '
      + 'including platform monitoring (Prometheus, Grafana, Alertmanager), logging (Loki), and git infrastructure (Gitea). '
      + 'You may inspect system services and diagnose cluster health directly.',
    );
  } else if (options?.isEscalated) {
    const ns = (options?.escalatedNamespaces ?? ['monitoring', 'gitea']).join(', ');
    sections.push(
      `## Escalated Privileges: Active\n`
      + `Elevated cluster access has been approved for this session. Scope includes system namespaces: ${ns}. `
      + `You may inspect diagnostics, logs, and events within these namespaces.`,
    );
  } else if (options?.activeTools?.includes('request_escalated_privileges')) {
    sections.push(
      '## Standard Tenant Boundaries\n'
      + 'You are operating with standard tenant privileges. If diagnosing an issue requires access to cluster system '
      + 'namespaces (e.g. monitoring, gitea, kube-system), call request_escalated_privileges with a clear, honest reason.',
    );
  }

  // 1.1 Secrets & Configuration Runtime Model
  if (options?.activeTools?.includes('request_secret') || options?.activeTools?.includes('inject_secret_to_pod')) {
    sections.push(
      '## Secrets & Configuration Runtime Model\n'
      + '- Applications run in Kubernetes containers where all secrets and configuration are injected as standard environment variables.\n'
      + '- When authoring or scaffolding application code, ALWAYS write code that reads from environment variables (e.g. process.env.<KEY> in Node.js, os.environ["<KEY>"] in Python). Do NOT write code that calls external vault APIs directly from inside the app.\n'
      + '- When an application requires a sensitive token, password, or API key from the user, NEVER ask them to paste it in plaintext chat. Always call request_secret to display a secure UI card.\n'
      + '- Once the user vaults the secret in Infisical, call inject_secret_to_pod to update the pod\'s Kubernetes Secret (<app>-secrets) and trigger a rolling restart.',
    );
  }

  // 2. Dynamic Tool Context
  const activeTools = options?.activeTools ?? [];
  const registry = options?.toolRegistry ?? TOOL_SEEDS;
  const toolMap = new Map(registry.map((t) => [t.name, t]));

  // Also collect tools from enabled MCP servers
  const enabledServers = options?.enabledServers ?? [];
  const mcpToolList: { name: string; description: string; fromServer: string }[] = [];
  if (options?.servers?.length) {
    for (const server of options.servers) {
      if (enabledServers.includes(server.name) && server.tools?.length) {
        for (const t of server.tools) {
          mcpToolList.push({ name: t.name, description: t.description ?? '', fromServer: server.name });
        }
      }
    }
  }

  const allActiveToolNames = Array.from(new Set([...activeTools, ...mcpToolList.map((t) => t.name)]));

  if (allActiveToolNames.length > 0) {
    const toolLines: string[] = [];

    if (pressure >= 0.50) {
      // Critical pressure (> 50%): minimal 1-phrase format
      for (const name of allActiveToolNames) {
        const item = toolMap.get(name);
        const desc = item?.compactGuidance ?? item?.description ?? mcpToolList.find((m) => m.name === name)?.description ?? name;
        toolLines.push(`- \`${name}\`: ${desc}`);
      }
    } else if (pressure >= 0.40) {
      // Moderate pressure (40% - 50%): compact 1-line guidance
      for (const name of allActiveToolNames) {
        const item = toolMap.get(name);
        const mcpItem = mcpToolList.find((m) => m.name === name);
        const guidance = item?.compactGuidance ?? item?.description ?? mcpItem?.description ?? '';
        toolLines.push(`- \`${name}\`: ${guidance}`);
      }
    } else {
      // Normal/Low pressure (< 40%): full rich operational guidance
      for (const name of allActiveToolNames) {
        const item = toolMap.get(name);
        const mcpItem = mcpToolList.find((m) => m.name === name);
        if (item) {
          const guide = item.usageGuidance ? ` — ${item.usageGuidance}` : '';
          toolLines.push(`- **${name}**: ${item.description}${guide}`);
        } else if (mcpItem) {
          toolLines.push(`- **${name}** (from ${mcpItem.fromServer}): ${mcpItem.description || 'MCP service tool.'}`);
        } else {
          toolLines.push(`- **${name}**`);
        }
      }
    }

    sections.push(`## Active Tools & Workflow Guidance\n${toolLines.join('\n')}`);
  }

  // 3. Available MCP Services
  if (options?.servers) {
    if (!options.servers.length) {
      sections.push('No services are deployed yet. Propose a project to build one.');
    } else {
      const serverLines = options.servers.map((s) => {
        const mark = enabledServers.includes(s.name) ? ' — ENABLED, its tools are loaded' : '';
        return `- ${s.name}${s.description ? `: ${s.description}` : ''}${mark}`;
      });
      sections.push(`## Services You Can Hook Up (via enable_mcp_server)\n${serverLines.join('\n')}`);
    }
  }

  // 4. Recalled Platform & Project Memories
  if (options?.memoryContext?.trim()) {
    sections.push(
      '## Recalled Platform & Project Memories\n'
      + 'Relevant lessons learned, environment facts, and proven patterns recalled from previous runs:\n\n'
      + options.memoryContext.trim(),
    );
  }

  // 5. Context Pressure Advisory
  if (pressure >= 0.48) {
    sections.push('[Notice: Context window is >48% full. Keep thoughts and answers concise.]');
  }

  return sections.join('\n\n');
}

/**
 * Backward-compatible wrapper for callers expecting buildKoalaPrompt.
 */
export function buildKoalaPrompt(
  base: string,
  servers: readonly McpServerItem[],
  enabled: readonly string[],
  activeTools?: readonly string[],
  options?: {
    isAdmin?: boolean;
    isEscalated?: boolean;
    escalatedNamespaces?: readonly string[];
    historyChars?: number;
    maxContextTokens?: number;
    toolRegistry?: readonly ToolRepositoryItem[];
  },
): string {
  return composePersonaPrompt(base, {
    servers,
    enabledServers: enabled,
    activeTools,
    ...options,
  });
}
