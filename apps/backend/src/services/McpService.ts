import type { McpRequest } from '@koala/harness-types';
import type { Conversation } from '../lib/conversations.js';
import { preferUsable, type McpServer } from '../lib/mcp-registry.js';

export interface McpStore {
  getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
  saveConversation(conversation: Conversation): Promise<void>;
  getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]>;
  getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined>;
  saveMcpRequest(request: McpRequest): Promise<void>;
}

export interface McpServerSummary {
  name: string;
  tools: { name: string; description?: string | undefined; readOnly: boolean }[];
  unreachable?: string | undefined;
}

export type McpDecision =
  | { ok: true; request?: McpRequest | undefined; conversation?: Conversation | undefined }
  | { ok: false; status: 400 | 404 | 409; error: string };

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
      })),
      ...(server.unreachable ? { unreachable: server.unreachable } : {}),
    }));
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
