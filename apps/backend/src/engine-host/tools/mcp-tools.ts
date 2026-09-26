import { randomUUID } from 'node:crypto';
import type { ToolContract, ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { McpRequest } from '@koala/harness-types';
import type { McpServer } from '../../lib/mcp-registry.js';
import { contractsFor, routeCall, serversFor, slugify } from '../../lib/mcp-tools.js';

export interface McpAccess {
  servers(ownerId: string): Promise<McpServer[]>;
  call(ownerId: string, server: McpServer, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface McpRunTools {
  contracts: ToolContract[];
  handlers: Record<string, ToolHandler>;
}

export interface McpToolSource {
  forRun(ownerId: string, persona: { mcp?: string[] | undefined }, conversationId?: string): Promise<McpRunTools>;
}

export interface McpToolStores {
  enabled(ownerId: string, conversationId: string): Promise<string[]>;
  requests: {
    list(ownerId: string, conversationId: string): Promise<McpRequest[]>;
    save(request: McpRequest): Promise<void>;
  };
}

const EMPTY: McpRunTools = { contracts: [], handlers: {} };

export function createMcpToolSource(options: { access: McpAccess; stores: McpToolStores }): McpToolSource {
  return {
    async forRun(ownerId, persona, conversationId) {
      const enabled = conversationId ? await options.stores.enabled(ownerId, conversationId) : [];
      const wanted = [...new Set([...(persona.mcp ?? []), ...enabled])];
      if (wanted.length === 0) return EMPTY;

      const servers = serversFor(wanted, await options.access.servers(ownerId));
      const contracts = contractsFor(servers);
      const handlers: Record<string, ToolHandler> = {};
      for (const contract of contracts) {
        handlers[contract.name] = async ({ parsed }): Promise<ToolOutcome> => {
          const route = routeCall(contract.name, servers);
          if (!route) return { ok: false, digest: `${contract.name} is not a tool that server offers`, content: '' };
          const out = await options.access.call(ownerId, route.server, route.tool, parsed);
          return { ok: !out.isError, digest: out.text, content: out.text };
        };
      }
      return { contracts, handlers };
    },
  };
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

export function createMcpRequestTools(options: {
  access: McpAccess;
  stores: McpToolStores;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  return {
    async enable_mcp_server({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to enable a server for');
      if (!caller.conversationId) return refuse('a server is switched on for a conversation, and this run is part of none');
      const name = asString(parsed, 'server');
      if (!name) return refuse('name the server to switch on');
      const why = asString(parsed, 'why');
      if (!why) return refuse('say why this conversation needs it, so the person can decide');

      const servers = await options.access.servers(caller.ownerId);
      const server = servers.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (!server) {
        const known = servers.map((candidate) => candidate.name).join(', ') || 'none';
        return refuse(`there is no MCP server called "${name}" — the servers this person runs are: ${known}`);
      }

      const enabled = await options.stores.enabled(caller.ownerId, caller.conversationId);
      if (enabled.includes(server.name)) {
        return { ok: true, digest: `${server.name}: already on`, content: `${server.name} is already switched on for this conversation; its tools are named ${slugify(server.name)}__<tool>.` };
      }
      const open = (await options.stores.requests.list(caller.ownerId, caller.conversationId))
        .find((request) => request.server === server.name && request.status === 'requested');
      if (open) return { ok: true, digest: `${server.name}: already asked`, content: `Already asked the person to switch ${server.name} on; nothing new was asked.` };

      const stamp = now();
      await options.stores.requests.save({
        id: newId(),
        ownerId: caller.ownerId,
        conversationId: caller.conversationId,
        server: server.name,
        why,
        status: 'requested',
        ...(caller.runId ? { runId: caller.runId } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      });
      return {
        ok: true,
        digest: `${server.name}: asked`,
        content: `Asked the person to switch ${server.name} on for this conversation. Its tools arrive on the next turn if they agree.`,
      };
    },
  };
}
