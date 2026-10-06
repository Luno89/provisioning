import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';
import type { Conversation } from '../lib/conversations.js';
import { titleFrom } from '../lib/conversations.js';
import { v4 as uuidv4 } from 'uuid';

export interface ConversationsRouterDeps {
  db: Database;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  ownedTrees?: (userId: string) => Promise<{ id: string }[]>;
  ownedProjects?: (userId: string) => Promise<{ id: string }[]>;
  workspaces?: { conclude(ownerId: string, conversationId: string): Promise<unknown> } | undefined;
  /** Settles a turn whose run ended without saving its reply, so reading never shows one that will not finish. */
  turns?: { settle(conversation: Conversation): Promise<Conversation> } | undefined;
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

  router.get('/:id', asyncRoute(async (req, res) => {
    const found = (await deps.ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    res.json(deps.turns ? await deps.turns.settle(found) : found);
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
    await db.saveConversation(conversation);
    res.json(conversation);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const found = (await deps.ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    await deps.workspaces?.conclude((req as any).user.id, found.id);
    await db.deleteConversation(found.id);
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
    if (typeof body.agentSlug === 'string' && body.agentSlug.trim()) {
      next.agentSlug = body.agentSlug.trim();
      changed = true;
    } else if (body.agentSlug === null) {
      delete next.agentSlug;
      changed = true;
    }
    if (!changed) return res.status(400).json({ error: 'Nothing to update' });
    next.updatedAt = new Date().toISOString();
    await db.saveConversation(next);
    res.json(next);
  }));

  return router;
}
