
import { routeCall } from './mcp-tools.js';
import { resolveMcpProbeUrl } from './mcp-probe-url.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { runTool } from './tool-registry.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { GiteaService } from '../services/GiteaService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { Database } from './db-interface.js';
import type { McpServer } from './mcp-registry.js';
import type { SearchOutcome } from './web-tools.js';
import type { ToolEffect } from './action-gate.js';

import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfisicalService } from '../services/InfisicalService.js';

export interface PackToolContext {
  db: Database;
  userId: string;
  /** A tool call attaches to whichever scope is talking — a conversation, or a tree-scoped branch. */
  conversationId?: string;
  branchId?: string;
  sessionId: string;
  enabledNames: string[];
  servers: McpServer[];
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
  registry?: Pick<McpRegistryService, 'call' | 'listWithTools'>;
  projects?: ProjectRepoService;
  kubectl?: (args: string[]) => Promise<string>;
  temporalBridge?: Pick<TemporalBridge, 'promoteProjectBuild'>;
  infisicalService?: InfisicalService | undefined;
  isAdmin?: boolean | undefined;
  isEscalated?: boolean | undefined;
  escalatedNamespaces?: readonly string[] | undefined;
  permitted?: readonly ToolEffect[] | undefined;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolExecResult {
  content: string;
  ok: boolean;
  enabled?: string;
  proposed?: unknown;
  proposedSpec?: unknown;
  proposedEscalation?: unknown;
  proposedSecretRequest?: unknown;
}

export function makePackToolExecutor(ctx: PackToolContext) {
  const registry = ctx.registry ?? new McpRegistryService(ctx.db, ctx.userId, (n: string) => resolveMcpProbeUrl(n));
  const kubectl = ctx.kubectl ?? ((a: string[]) =>
    new InfrastructureService().runKubectl(a).then((r: any) => typeof r === 'string' ? r : (r?.stdout ?? '')));
  /**
   * A chat can reach the project repositories and the MCP registry, so the tools that need them
   * work here too. Withholding them is what made `list_projects` answer `No tool named` in a chat
   * whose own pack granted it.
   */
  const projects = ctx.projects ?? new ProjectRepoService(
    ctx.db,
    new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    ),
    process.env.JWT_SECRET ?? '',
  );

  return async (c: ToolCall): Promise<ToolExecResult> => {
    const route = routeCall(c.name, ctx.enabledNames);
    if (route) {
      const server = ctx.servers.find((s) => s.name === route.server);
      let text: string;
      try {
        const got = server
          ? await registry.call(server, route.tool, JSON.parse(c.arguments || '{}'))
          : { text: `"${route.server}" is no longer running.` };
        text = got.text ?? '';
      } catch (err: any) {
        text = `That call failed: ${String(err?.message ?? err).slice(0, 200)}`;
      }
      return { content: text, ok: !ctx.toolRefused(text) };
    }

    const out = await runTool(
      {
        db: ctx.db, userId: ctx.userId,
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
        sessionId: ctx.sessionId,
        servers: ctx.servers, webSearch: ctx.webSearch, fetchWebPage: ctx.fetchWebPage,
        kubectl,
        projects,
        mcpRegistry: registry,
        temporalBridge: ctx.temporalBridge,
        infisicalService: ctx.infisicalService,
        isAdmin: ctx.isAdmin,
        isEscalated: ctx.isEscalated,
        escalatedNamespaces: ctx.escalatedNamespaces,
        permitted: ctx.permitted,
      },
      { name: c.name, arguments: c.arguments },
    );
    if (out.enabled && !ctx.enabledNames.includes(out.enabled)) ctx.enabledNames.push(out.enabled);
    return {
      content: out.content,
      ok: !ctx.toolRefused(out.content),
      ...(out.enabled ? { enabled: out.enabled } : {}),
      ...(out.proposed ? { proposed: out.proposed } : {}),
      ...(out.proposedSpec ? { proposedSpec: out.proposedSpec } : {}),
      ...(out.proposedEscalation ? { proposedEscalation: out.proposedEscalation } : {}),
      ...(out.proposedSecretRequest ? { proposedSecretRequest: out.proposedSecretRequest } : {}),
    };
  };
}