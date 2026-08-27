/* ═══════════════ chat-pack/tools — the pack's tool dispatcher ═══════════════ */

/**
 * Executes a tool call for a persona-pack turn, extracted from the router so it is testable alone.
 *
 * The dispatch order is load-bearing and matches koala exactly: a qualified `server__tool` name
 * (an ENABLED service) goes to that service's MCP registry; anything else is one of the pack's own
 * tools (koala's chain). Checking MCP first is safe only because `routeCall` refuses any name that
 * is not `server__tool` for an enabled service — it can never swallow a koala tool.
 */
import { routeCall } from './mcp-tools.js';
import { resolveMcpProbeUrl } from './mcp-probe-url.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { runKoalaTool } from './koala-tool-runner.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import type { Database } from './db-interface.js';
import type { McpServer } from './mcp-registry.js';
import type { SearchOutcome } from './web-tools.js';

import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfisicalService } from '../services/InfisicalService.js';

export interface PackToolContext {
  db: Database;
  userId: string;
  conversationId: string;
  sessionId: string;
  enabledNames: string[];
  servers: McpServer[];
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
  /** Injected so a test can substitute a stub rather than a real registry. */
  registry?: Pick<McpRegistryService, 'call'>;
  kubectl?: (args: string[]) => Promise<string>;
  temporalBridge?: Pick<TemporalBridge, 'promoteProjectBuild'>;
  infisicalService?: InfisicalService | undefined;
  isAdmin?: boolean | undefined;
  isEscalated?: boolean | undefined;
  escalatedNamespaces?: readonly string[] | undefined;
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

/** Builds the dispatcher for one turn. Injects nothing global; all deps come from ctx. */
export function makePackToolExecutor(ctx: PackToolContext) {
  const registry = ctx.registry ?? new McpRegistryService(ctx.db, ctx.userId, (n: string) => resolveMcpProbeUrl(n));
  const kubectl = ctx.kubectl ?? ((a: string[]) =>
    new InfrastructureService().runKubectl(a).then((r: any) => typeof r === 'string' ? r : (r?.stdout ?? '')));

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

    const out = await runKoalaTool(
      {
        db: ctx.db, userId: ctx.userId, conversationId: ctx.conversationId, sessionId: ctx.sessionId,
        servers: ctx.servers, webSearch: ctx.webSearch, fetchWebPage: ctx.fetchWebPage,
        kubectl,
        temporalBridge: ctx.temporalBridge,
        infisicalService: ctx.infisicalService,
        isAdmin: ctx.isAdmin,
        isEscalated: ctx.isEscalated,
        escalatedNamespaces: ctx.escalatedNamespaces,
      },
      { name: c.name, arguments: c.arguments },
    );
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