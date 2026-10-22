import { exceedsCeiling, type ToolContract, type ToolEffect, type ToolHandler, type ToolOutcome, type WithheldTool } from '@koala/engine-core';
import type { McpTool } from '../../engine/index.js';
import { contractFor } from '../../engine/lib/mcp-tools.js';
import { offers, serverPath, serverState, usable, withKind, type McpServerRecord, type ServerRuns } from '../../engine/lib/mcp-servers.js';
import type { EnvironmentHandleRef, RunTicket } from '../temporal/contracts.js';
import type { WorkspaceServers } from './workspace-servers.js';

export interface HostedServers {
  call(ownerId: string, runs: Extract<ServerRuns, { where: 'hosted' }>, tool: string, args: Record<string, unknown>, signal?: AbortSignal | undefined): Promise<{ text: string; isError: boolean }>;
}

export interface ServerToolDeps {
  catalogue(ownerId: string): Promise<readonly McpServerRecord[]>;
  enabled(ownerId: string, conversationId: string): Promise<readonly string[]>;
  hosted: HostedServers;
  workspace?: WorkspaceServers | undefined;
}

export interface ServerToolRequest {
  ticket: RunTicket;
  environment?: EnvironmentHandleRef | undefined;
  held: readonly string[];
  ceiling?: ToolEffect | undefined;
}

export interface OfferedServerTools {
  tools: ToolContract[];
  withheld: WithheldTool[];
  handlers: Record<string, ToolHandler>;
}

export interface ServerTools {
  forRun(request: ServerToolRequest): Promise<OfferedServerTools>;
}

export function notUsableWhy(server: McpServerRecord): string {
  const state = serverState(server);
  if (state.state === 'capturing') return 'it is being captured; its tools are offered once that finishes';
  if (state.state === 'failed') return `its last capture failed, so it is offered to no one: ${state.why}`;
  if (state.state === 'stale') return 'how it runs changed since it was captured, so it has to be captured again before it is offered';
  return 'it has not been captured yet, so nothing knows which tools it serves';
}

function contractOf(server: McpServerRecord, tool: McpTool): ToolContract {
  const said = server.tools?.[tool.name];
  const annotations = withKind(tool.annotations, said?.kind);
  const { description, ...contract } = contractFor(server.name, { ...tool, ...(annotations ? { annotations } : {}) });
  return {
    ...contract,
    description: tool.description?.trim() || `The ${tool.name} tool.`,
    binding: server.runs.where === 'workspace' ? 'environment' : 'network',
    ...(said?.note?.trim() ? { usageGuidance: said.note.trim() } : {}),
    servedBy: {
      server: server.name,
      where: server.runs.where,
      ...(server.summary ? { summary: server.summary } : {}),
      ...(server.captured?.instructions ? { instructions: server.captured.instructions } : {}),
      ...(server.notes ? { notes: server.notes } : {}),
      ...(server.dependsOn ? { dependsOn: server.dependsOn } : {}),
    },
  };
}

export function createServerTools(deps: ServerToolDeps): ServerTools {
  return {
    async forRun({ ticket, environment, held, ceiling }) {
      const enabled = ticket.conversationId ? await deps.enabled(ticket.ownerId, ticket.conversationId) : [];
      const wanted = [...new Set([...held, ...enabled])];
      if (wanted.length === 0) return { tools: [], withheld: [], handlers: {} };

      const catalogue = await deps.catalogue(ticket.ownerId);
      const tools: ToolContract[] = [];
      const withheld: WithheldTool[] = [];
      const handlers: Record<string, ToolHandler> = {};

      for (const name of wanted) {
        const server = catalogue.find((entry) => entry.name === name);
        if (!server) {
          withheld.push({ name, why: 'there is no MCP server by that name in the catalogue' });
          continue;
        }
        if (!usable(server)) {
          withheld.push({ name, why: notUsableWhy(server) });
          continue;
        }
        if (server.runs.where === 'workspace' && (!environment || environment.spec.kind !== 'sandbox' || !deps.workspace)) {
          withheld.push({ name, why: 'it runs in a workspace, and this run has none' });
          continue;
        }
        for (const tool of server.captured!.tools.filter((entry) => offers(server, entry.name))) {
          const contract = contractOf(server, tool);
          if (exceedsCeiling(contract, ceiling)) {
            withheld.push({ name: contract.name, why: 'this agent may not do what that tool does' });
            continue;
          }
          tools.push(contract);
          handlers[contract.name] = async ({ parsed, signal }): Promise<ToolOutcome> => {
            if (server.runs.where === 'workspace') {
              const runs = server.runs;
              return deps.workspace!.call({ ticket, environment, server: { name: server.name, start: runs.start, port: runs.port, path: serverPath(runs) }, tool: tool.name, args: parsed, signal });
            }
            const out = await deps.hosted.call(ticket.ownerId, server.runs, tool.name, parsed, signal);
            return { ok: !out.isError, digest: out.text, content: out.text };
          };
        }
      }
      return { tools, withheld, handlers };
    },
  };
}

