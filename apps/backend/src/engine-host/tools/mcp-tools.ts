import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { McpRequest } from '@koala/harness-types';
import { usable, type McpServerRecord } from '../../lib/mcp-servers.js';
import { slugify } from '../../lib/mcp-tools.js';

export interface McpToolStores {
  enabled(ownerId: string, conversationId: string): Promise<string[]>;
  requests: {
    list(ownerId: string, conversationId: string): Promise<McpRequest[]>;
    save(request: McpRequest): Promise<void>;
  };
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

export function createMcpRequestTools(options: {
  catalogue: (ownerId: string) => Promise<readonly McpServerRecord[]>;
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

      const servers = (await options.catalogue(caller.ownerId)).filter((candidate) => candidate.runs.where === 'hosted' && usable(candidate));
      const server = servers.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (!server) {
        const known = servers.map((candidate) => candidate.name).join(', ') || 'none';
        return refuse(`there is no hosted MCP server called "${name}" that is ready to use — the ones that are: ${known}`);
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
