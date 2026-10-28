import type { AccessRequest } from '@koala/harness-types';
import type { Conversation } from '../../engine/index.js';
import { namespacesProblem } from '../lib/kube-diagnostics.js';
import { authorize, type Principal } from '../../platform/index.js';

export interface AccessStore {
  infrastructure: {
    getAccessRequests(ownerId: string, conversationId?: string): Promise<AccessRequest[]>;
    getAccessRequest(ownerId: string, id: string): Promise<AccessRequest | undefined>;
    saveAccessRequest(request: AccessRequest): Promise<void>;
  };
  engine: {
    getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
    saveConversation(conversation: Conversation): Promise<void>;
  };
}

export type AccessDecision =
  | { ok: true; request: AccessRequest }
  | { ok: false; status: 403 | 404 | 409; error: string };

export class AccessService {
  constructor(private readonly deps: { store: AccessStore; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  list(ownerId: string, conversationId?: string): Promise<AccessRequest[]> {
    return this.deps.store.infrastructure.getAccessRequests(ownerId, conversationId);
  }

  private async open(ownerId: string, id: string): Promise<{ opened: AccessRequest } | AccessDecision> {
    const request = await this.deps.store.infrastructure.getAccessRequest(ownerId, id);
    if (!request) return { ok: false, status: 404, error: 'Request not found' };
    if (request.status !== 'requested') return { ok: false, status: 409, error: `This request is already ${request.status}.` };
    return { opened: request };
  }

  async grant(user: Principal, id: string): Promise<AccessDecision> {
    const decision = authorize(user, 'open-platform-namespaces', { kind: 'install' });
    if (!decision.allowed) return { ok: false, status: decision.status, error: decision.error };
    const found = await this.open(user.id, id);
    if (!('opened' in found)) return found;
    const request = found.opened;
    const problem = namespacesProblem(request.namespaces);
    if (problem) return { ok: false, status: 409, error: problem };
    const conversation = await this.deps.store.engine.getConversation(user.id, request.conversationId);
    if (!conversation) return { ok: false, status: 404, error: 'The conversation this was asked in no longer exists' };

    const stamp = this.now();
    await this.deps.store.engine.saveConversation({
      ...conversation,
      platformNamespaces: [...new Set([...(conversation.platformNamespaces ?? []), ...request.namespaces])],
      updatedAt: stamp,
    });
    const granted: AccessRequest = { ...request, status: 'granted', updatedAt: stamp };
    await this.deps.store.infrastructure.saveAccessRequest(granted);
    return { ok: true, request: granted };
  }

  async dismiss(ownerId: string, id: string): Promise<AccessDecision> {
    const found = await this.open(ownerId, id);
    if (!('opened' in found)) return found;
    const dismissed: AccessRequest = { ...found.opened, status: 'dismissed', updatedAt: this.now() };
    await this.deps.store.infrastructure.saveAccessRequest(dismissed);
    return { ok: true, request: dismissed };
  }
}
