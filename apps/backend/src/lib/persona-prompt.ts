
import { contextPressure } from './sampling.js';
import { ALL_TOOL_SEEDS, type ToolRepositoryItem } from './tool-seeds.js';
import type { BudgetConfig, PromptConfig } from '@koala/harness-types';

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
 * Fills `{{name}}` placeholders in a section. A section a pack has blanked emits nothing, which is
 * how a pack turns a section off without the composer knowing which sections exist.
 */
function section(template: string, values: Record<string, string | number> = {}): string | undefined {
  const text = template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    (key in values ? String(values[key]) : whole));
  return text.trim() ? text : undefined;
}

export function composePersonaPrompt(
  budget: BudgetConfig,
  prompt: PromptConfig,
  basePrompt: string,
  options?: PersonaPromptOptions,
): string {
  const sections: string[] = [basePrompt.trim()];
  const historyChars = options?.historyChars ?? 0;
  const pressure = contextPressure(budget, basePrompt.length + historyChars, options?.maxContextTokens);
  const push = (text: string | undefined) => { if (text) sections.push(text); };

  if (options?.isAdmin) {
    push(section(prompt.sections.role.admin));
  } else if (options?.isEscalated) {
    push(section(prompt.sections.role.escalated, {
      namespaces: (options?.escalatedNamespaces ?? ['monitoring', 'gitea']).join(', '),
    }));
  } else if (options?.activeTools?.includes('request_escalated_privileges')) {
    push(section(prompt.sections.role.standard));
  }

  if (options?.activeTools?.includes('request_secret') || options?.activeTools?.includes('inject_secret_to_pod')) {
    push(section(prompt.sections.secrets));
  }

  const activeTools = options?.activeTools ?? [];
  const registry = options?.toolRegistry ?? ALL_TOOL_SEEDS;
  const toolMap = new Map(registry.map((t) => [t.name, t]));

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

    if (pressure >= prompt.pressure.minimalAt) {
      for (const name of allActiveToolNames) {
        const item = toolMap.get(name);
        const desc = item?.compactGuidance ?? item?.description ?? mcpToolList.find((m) => m.name === name)?.description ?? name;
        toolLines.push(`- \`${name}\`: ${desc}`);
      }
    } else if (pressure >= prompt.pressure.compactAt) {
      for (const name of allActiveToolNames) {
        const item = toolMap.get(name);
        const mcpItem = mcpToolList.find((m) => m.name === name);
        const guidance = item?.compactGuidance ?? item?.description ?? mcpItem?.description ?? '';
        toolLines.push(`- \`${name}\`: ${guidance}`);
      }
    } else {
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

    const heading = section(prompt.sections.toolGuidance);
    if (heading) sections.push(`${heading}\n${toolLines.join('\n')}`);
  }

  if (options?.servers) {
    if (!options.servers.length) {
      push(section(prompt.sections.services.none));
    } else {
      const serverLines = options.servers.map((s) => {
        const mark = enabledServers.includes(s.name) ? ' — ENABLED, its tools are loaded' : '';
        return `- ${s.name}${s.description ? `: ${s.description}` : ''}${mark}`;
      });
      const servicesHeading = section(prompt.sections.services.heading);
      if (servicesHeading) sections.push(`${servicesHeading}\n${serverLines.join('\n')}`);
    }
  }

  if (options?.memoryContext?.trim()) {
    const heading = section(prompt.sections.memories);
    if (heading) sections.push(`${heading}\n\n${options.memoryContext.trim()}`);
  }

  if (pressure >= prompt.pressure.noticeAt) {
    push(section(prompt.sections.pressureNotice, {
      percent: Math.round(prompt.pressure.noticeAt * 100),
    }));
  }

  return sections.join('\n\n');
}

export function buildKoalaPrompt(
  budget: BudgetConfig,
  prompt: PromptConfig,
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
  return composePersonaPrompt(budget, prompt, base, {
    servers,
    enabledServers: enabled,
    activeTools,
    ...options,
  });
}
