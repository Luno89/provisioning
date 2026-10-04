import type { McpRequest } from '@koala/harness-types';
import type { Conversation } from '../lib/conversations.js';
import { preferUsable, type McpServer } from '../lib/mcp-registry.js';
import { contractFor } from '../lib/mcp-tools.js';
import { HINT_CHOICES, overriddenAnnotations, type HintChoice, type McpToolHint } from '../lib/mcp-tool-hints.js';

export interface McpStore {
  getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
  saveConversation(conversation: Conversation): Promise<void>;
  getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]>;
  getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined>;
  saveMcpRequest(request: McpRequest): Promise<void>;
  saveMcpToolHint(hint: McpToolHint): Promise<void>;
  deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void>;
}

export type McpToolKind = 'read-only' | 'safe-write' | 'destructive';

export interface McpServerSummary {
  name: string;
  tools: {
    name: string;
    description?: string | undefined;
    readOnly: boolean;
    kind: McpToolKind;
    declared: McpToolKind;
    choice: HintChoice;
  }[];
  unreachable?: string | undefined;
}

export type McpDecision =
  | { ok: true; request?: McpRequest | undefined; conversation?: Conversation | undefined }
  | { ok: false; status: 400 | 404 | 409; error: string };

function kindOf(server: string, annotations: Parameters<typeof overriddenAnnotations>[0]): McpToolKind {
  const contract = contractFor(server, { name: 'probe', ...(annotations ? { annotations } : {}) });
  if (contract.effect === 'read') return 'read-only';
  return contract.destructive ? 'destructive' : 'safe-write';
}

export class McpService {
  constructor(private readonly deps: {
    store: McpStore;
    servers: (ownerId: string) => Promise<McpServer[]>;
    now?: () => string;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async servers(ownerId: string): Promise<McpServerSummary[]> {
    return preferUsable(await this.deps.servers(ownerId)).map((server) => ({
      name: server.name,
      tools: server.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        readOnly: tool.annotations?.readOnlyHint === true,
        kind: kindOf(server.name, tool.annotations),
        declared: kindOf(server.name, tool.choice ? tool.declared : tool.annotations),
        choice: tool.choice ?? 'server',
      })),
      ...(server.unreachable ? { unreachable: server.unreachable } : {}),
    }));
  }

  async setToolHint(ownerId: string, server: string, tool: string, choice: unknown): Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }> {
    if (typeof choice !== 'string' || !(HINT_CHOICES as readonly string[]).includes(choice)) {
      return { ok: false, status: 400, error: `choice has to be one of ${HINT_CHOICES.join(', ')}` };
    }
    const found = (await this.deps.servers(ownerId)).find((entry) => entry.name === server)?.tools.some((entry) => entry.name === tool);
    if (!found) return { ok: false, status: 404, error: `${server} offers no tool called ${tool}` };
    if (choice === 'server') await this.deps.store.deleteMcpToolHint(ownerId, server, tool);
    else await this.deps.store.saveMcpToolHint({ ownerId, server, tool, choice: choice as Exclude<HintChoice, 'server'>, updatedAt: this.now() });
    return { ok: true };
  }

  async serverNames(ownerId: string): Promise<string[]> {
    return [...new Set((await this.deps.servers(ownerId)).map((server) => server.name))];
  }

  requests(ownerId: string, conversationId?: string): Promise<McpRequest[]> {
    return this.deps.store.getMcpRequests(ownerId, conversationId);
  }

  async setConversationServers(ownerId: string, conversationId: string, names: unknown): Promise<McpDecision> {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      return { ok: false, status: 400, error: 'servers has to be a list of server names' };
    }
    const conversation = await this.deps.store.getConversation(ownerId, conversationId);
    if (!conversation) return { ok: false, status: 404, error: 'No such conversation' };
    const known = new Set(await this.serverNames(ownerId));
    const unknown = (names as string[]).filter((name) => !known.has(name));
    if (unknown.length > 0) return { ok: false, status: 400, error: `not one of your MCP servers: ${unknown.join(', ')}` };

    const saved: Conversation = { ...conversation, mcpServers: [...new Set(names as string[])], updatedAt: this.now() };
    await this.deps.store.saveConversation(saved);
    return { ok: true, conversation: saved };
  }

  private async open(ownerId: string, id: string): Promise<{ opened: McpRequest } | McpDecision> {
    const request = await this.deps.store.getMcpRequest(ownerId, id);
    if (!request) return { ok: false, status: 404, error: 'Request not found' };
    if (request.status !== 'requested') return { ok: false, status: 409, error: `This request is already ${request.status}.` };
    return { opened: request };
  }

  async enable(ownerId: string, id: string): Promise<McpDecision> {
    const found = await this.open(ownerId, id);
    if (!('opened' in found)) return found;
    const request = found.opened;
    const conversation = await this.deps.store.getConversation(ownerId, request.conversationId);
    if (!conversation) return { ok: false, status: 404, error: 'The conversation this was asked in no longer exists' };
    if (!(await this.serverNames(ownerId)).includes(request.server)) {
      return { ok: false, status: 409, error: `${request.server} is no longer running` };
    }

    const stamp = this.now();
    const saved: Conversation = { ...conversation, mcpServers: [...new Set([...(conversation.mcpServers ?? []), request.server])], updatedAt: stamp };
    await this.deps.store.saveConversation(saved);
    const enabled: McpRequest = { ...request, status: 'enabled', updatedAt: stamp };
    await this.deps.store.saveMcpRequest(enabled);
    return { ok: true, request: enabled, conversation: saved };
  }

  async dismiss(ownerId: string, id: string): Promise<McpDecision> {
    const found = await this.open(ownerId, id);
    if (!('opened' in found)) return found;
    const dismissed: McpRequest = { ...found.opened, status: 'dismissed', updatedAt: this.now() };
    await this.deps.store.saveMcpRequest(dismissed);
    return { ok: true, request: dismissed };
  }
}
