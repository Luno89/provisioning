import type { ModelReach } from '@koala/harness-types';
import { readAttachments } from '../lib/attachments.js';
import { Router } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { Conversation } from '../lib/conversations.js';
import { personMessage, titleFrom, withAuthorNames } from '../lib/conversations.js';
import { conversationContext } from '../lib/conversation-context.js';
import { v4 as uuidv4 } from 'uuid';

export interface ConversationsRouterDeps {
  db: Database;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  ownedTrees?: (userId: string) => Promise<{ id: string }[]>;
  ownedProjects?: (userId: string) => Promise<{ id: string }[]>;
  workspaces?: {
    conclude(ownerId: string, conversationId: string): Promise<unknown>;
    state?(conversationId: string): Promise<'none' | 'running' | 'parked'>;
  } | undefined;
  turns?: { settle(conversation: Conversation): Promise<Conversation> } | undefined;
  posted?: ((ownerId: string, conversationId: string) => void) | undefined;
  binding?: ((ownerId: string, conversationId: string) => Promise<Record<string, string> | undefined>) | undefined;
}

export function conversationsRouter(deps: ConversationsRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const mine = await deps.ownedConversations((req as any).user.id);
    res.json(mine
      .map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
  }));

  router.get('/:id/workspace', asyncRoute(async (req, res) => {
    const conversation = (await deps.ownedConversations((req as unknown as { user: { id: string } }).user.id)).find((entry) => entry.id === String(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!deps.workspaces?.state) return res.status(404).json({ error: 'This server keeps no conversation workspaces' });
    return res.json({ state: await deps.workspaces.state(conversation.id) });
  }));

  router.get('/:id/context', asyncRoute(async (req, res) => {
    const userId = (req as unknown as { user: { id: string } }).user.id;
    const conversation = (await deps.ownedConversations(userId)).find((entry) => entry.id === String(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    return res.json(conversationContext(await deps.binding?.(userId, conversation.id)));
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const viewer = (req as unknown as { user: { id: string } }).user.id;
    const found = (await deps.ownedConversations(viewer)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    const settled = deps.turns ? await deps.turns.settle(found) : found;
    const members = new Map((await db.hub.getHubLinks()).flatMap((link) => link.members ?? []).map((member) => [member.personId, member.email]));
    res.json(members.size > 0 ? withAuthorNames(settled, viewer, members) : settled);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;
    const treeId = typeof req.body?.treeId === 'string' && req.body.treeId.trim() ? req.body.treeId.trim() : undefined;
    const projectId = typeof req.body?.projectId === 'string' && req.body.projectId.trim() ? req.body.projectId.trim() : undefined;
    if (treeId && projectId) return res.status(400).json({ error: 'A conversation is about a tree or a project, not both' });
    if (treeId) {
      const trees = deps.ownedTrees ? await deps.ownedTrees(userId) : [];
      if (!trees.some((tree) => tree.id === treeId)) return res.status(404).json({ error: 'No such tree' });
    }
    if (projectId) {
      const projects = deps.ownedProjects ? await deps.ownedProjects(userId) : [];
      if (!projects.some((project) => project.id === projectId)) return res.status(404).json({ error: 'No such project' });
    }
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: uuidv4(),
      ownerId: userId,
      title: titleFrom(String(req.body?.title ?? '')),
      ...(treeId ? { treeId } : {}),
      ...(projectId ? { projectId } : {}),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.engine.saveConversation(conversation);
    res.json(conversation);
  }));

  router.post('/:id/messages', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;
    const found = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    if (found.kind !== 'channel') return res.status(409).json({ error: 'Only a project\'s channel takes messages without a turn; this conversation answers every message' });
    const attached = readAttachments(req.body?.attachments, (await db.projects.getProjects()).filter((project: { ownerId?: string }) => project.ownerId === userId));
    if (!attached.ok) return res.status(400).json({ error: attached.why });
    const message = personMessage(userId, String(req.body?.content ?? ''), new Date().toISOString(), attached.attachments);
    if ('problem' in message) return res.status(400).json({ error: message.problem });
    if (!(await db.engine.appendMessage(found.ownerId, found.id, message))) return res.status(404).json({ error: 'No such conversation' });
    deps.posted?.(found.ownerId, found.id);
    return res.status(201).json({ message });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const found = (await deps.ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    await deps.workspaces?.conclude((req as any).user.id, found.id);
    await db.engine.deleteConversation(found.id);
    res.json({ success: true });
  }));

  /**
   * Patch chat-owned metadata on a conversation: the running agent (slug) and the model this
   * conversation was last sent on. The engine's save path preserves stored fields it does not
   * write itself, so these ride the conversation doc and survive engine turns; the chat surface
   * hydrates both from the doc on load and patches them when the user makes a choice.
   */
  router.patch('/:id', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;
    const found = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    const body = req.body ?? {};
    const next: Conversation = { ...found };
    let changed = false;
    if (typeof body.modelId === 'string' && body.modelId.trim()) {
      next.modelId = body.modelId.trim();
      changed = true;
    } else if (body.modelId === null) {
      delete next.modelId;
      changed = true;
    }
    if (body.modelReach === 'handoffs' || body.modelReach === 'chat') {
      next.modelReach = body.modelReach as ModelReach;
      changed = true;
    } else if (body.modelReach === null) {
      delete next.modelReach;
      changed = true;
    }
    if (typeof body.agentSlug === 'string' && body.agentSlug.trim()) {
      next.agentSlug = body.agentSlug.trim();
      changed = true;
    } else if (body.agentSlug === null) {
      delete next.agentSlug;
      changed = true;
    }
    if (!changed) return res.status(400).json({ error: 'Nothing to update' });
    next.updatedAt = new Date().toISOString();
    await db.engine.saveConversation(next);
    res.json(next);
  }));

  return router;
}
