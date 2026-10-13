import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { ActionProposal, McpRequest } from '@koala/harness-types';
import { usable, type McpServerRecord, type McpServerTemplate } from '../../lib/mcp-servers.js';
import { slugify } from '../../lib/mcp-tools.js';
import { draftServerProposal, runsLines, stateLine } from '../../lib/mcp-proposals.js';
import { sameAction } from '../../lib/action-proposals.js';

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

export interface McpProposalAccess {
  templates: () => readonly McpServerTemplate[];
  agents: (ownerId: string) => Promise<readonly { slug: string; servers?: readonly string[] | undefined }[]>;
  proposals: {
    list(ownerId: string): Promise<ActionProposal[]>;
    save(proposal: ActionProposal): Promise<void>;
  };
}

export function createMcpRequestTools(options: {
  catalogue: (ownerId: string) => Promise<readonly McpServerRecord[]>;
  stores: McpToolStores;
  proposing?: McpProposalAccess | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  const proposing = options.proposing;
  const catalogueTools = proposing ? {
    async list_mcp_servers({ caller }: Parameters<ToolHandler>[0]): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose servers to list');
      const [servers, agents] = await Promise.all([options.catalogue(caller.ownerId), proposing.agents(caller.ownerId)]);
      const heldBy = (name: string) => agents.filter((agent) => (agent.servers ?? []).includes(name)).map((agent) => agent.slug);
      const added = new Set(servers.flatMap((server) => (server.from && 'template' in server.from ? [server.from.template] : [])));
      const mine = [...servers].sort((a, b) => a.name.localeCompare(b.name)).map((server) => [
        `- ${server.name}${server.summary ? `: ${server.summary}` : ''}`,
        `  ${runsLines(server.runs)[0]}; ${stateLine(server)}`,
        `  Held by: ${heldBy(server.name).join(', ') || 'no agent'}`,
      ].join('\n'));
      const known = proposing.templates().filter((template) => !added.has(template.id)).map((template) => `- ${template.id}: ${template.summary} (${runsLines(template.runs)[0]!.toLowerCase()})`);
      const content = [
        'YOUR MCP SERVERS', '', ...(mine.length ? mine : ['None yet.']), '',
        'KNOWN SERVERS YOU CAN ADD', '', ...(known.length ? known : ['None that are not added already.']),
      ].join('\n');
      return { ok: true, digest: `${servers.length} server${servers.length === 1 ? '' : 's'}, ${known.length} known to add`, content };
    },

    async propose_mcp_server({ parsed, caller }: Parameters<ToolHandler>[0]): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to propose a server for');
      const [servers, agents] = await Promise.all([options.catalogue(caller.ownerId), proposing.agents(caller.ownerId)]);
      const drafted = draftServerProposal(parsed, { servers, templates: proposing.templates(), agents });
      if ('problem' in drafted) return refuse(`${drafted.problem}; nothing was proposed`);
      const params = { spec: JSON.stringify(drafted.proposal) };
      const open = (await proposing.proposals.list(caller.ownerId)).find((entry) => entry.status === 'proposed' && sameAction(entry, 'add_mcp_server', params));
      if (open) return { ok: true, digest: `already proposed: ${open.summary}`, content: `This is already waiting for the person on a card (${open.summary}); nothing new was proposed.` };
      const stamp = now();
      const proposal: ActionProposal = {
        id: newId(),
        ownerId: caller.ownerId,
        kind: 'add_mcp_server',
        summary: drafted.summary,
        detail: drafted.detail,
        params,
        status: 'proposed',
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      };
      await proposing.proposals.save(proposal);
      return { ok: true, digest: `proposed: ${drafted.summary}`, content: `Proposed on a card: ${drafted.summary}. Nothing changes until the person applies it.` };
    },
  } : {};

  return {
    ...catalogueTools,
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
