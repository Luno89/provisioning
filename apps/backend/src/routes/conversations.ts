import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';
import type { Conversation } from '../lib/conversations.js';
import { titleFrom } from '../lib/conversations.js';
import { withConversationNotice } from '../lib/conversation-notice.js';
import { v4 as uuidv4 } from 'uuid';
import { validateSpec, explainSpecProblems } from '../lib/app-spec-validate.js';
import { visibleAppSpecs, type AppSpec } from '../lib/app-spec.js';
import { frozenTreeIds, FROZEN_TREE } from '../lib/leaves.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { InfisicalService } from '../services/InfisicalService.js';

export interface ConversationsRouterDeps {
  db: Database;
  projectRepoService?: ProjectRepoService;
  temporalBridge?: TemporalBridge;
  infraService?: InfrastructureService;
  infisicalService?: InfisicalService;
  jwtSecret?: string;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  ownedTrees?: (userId: string) => Promise<{ id: string }[]>;
  ownedProjects?: (userId: string) => Promise<{ id: string }[]>;
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
    res.json(found);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;
    const treeId = typeof req.body?.treeId === 'string' && req.body.treeId.trim() ? req.body.treeId.trim() : undefined;
    const projectId = typeof req.body?.projectId === 'string' && req.body.projectId.trim() ? req.body.projectId.trim() : undefined;
    if (treeId && projectId) return res.status(400).json({ error: 'A conversation is about a tree or a project, not both' });
    if (treeId) {
      const trees = deps.ownedTrees ? await deps.ownedTrees(userId) : [];
      if (!trees.some((tree) => tree.id === treeId)) return res.status(404).json({ error: 'No such tree' });
      if (frozenTreeIds(await db.getBranches(), await db.getLeaves()).has(treeId)) return res.status(409).json({ error: FROZEN_TREE });
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

  const dismissTree = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedTrees ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.treeId) return res.status(409).json({ error: 'That project has already been created' });
    if (proposal.dismissedAt) return res.status(409).json({ error: 'That proposal was already dismissed' });

    const now = new Date().toISOString();
    await db.saveConversation(withConversationNotice({
      ...conversation,
      proposedTrees: (conversation.proposedTrees ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, dismissedAt: now } : p)),
      updatedAt: now,
    }, `Dismissed the "${proposal.name}" tree proposal.`, now));
    res.json({ ok: true });
  };

  router.post('/:id/trees/:proposalId/dismiss', asyncRoute(dismissTree));
  router.post('/:id/proposals/:proposalId/dismiss', asyncRoute(dismissTree));

  router.post('/:id/specs/:proposalId/accept', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedSpecs ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.acceptedAt) return res.status(409).json({ error: 'That app type already exists' });

    const problems = validateSpec(proposal.spec);
    if (problems.length) return res.status(400).json({ error: explainSpecProblems(problems) });

    const existing = visibleAppSpecs(await db.getAppSpecs(), userId).find((s) => s.id === proposal.id);
    if (existing?.builtIn) {
      return res.status(409).json({ error: `"${proposal.id}" ships with the platform and cannot be replaced.` });
    }

    const now = new Date().toISOString();
    await db.saveAppSpec({
      id: proposal.id,
      spec: proposal.spec as AppSpec,
      builtIn: false,
      ownerId: userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await db.saveConversation(withConversationNotice({
      ...conversation,
      proposedSpecs: (conversation.proposedSpecs ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, acceptedAt: now } : p)),
      updatedAt: now,
    }, `Added "${proposal.id}" to the catalogue.`, now));
    res.json({ id: proposal.id });
  }));

  const dismissSpec = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedSpecs ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.acceptedAt) return res.status(409).json({ error: 'That app type already exists' });
    if (proposal.dismissedAt) return res.status(409).json({ error: 'That proposal was already dismissed' });

    const now = new Date().toISOString();
    await db.saveConversation(withConversationNotice({
      ...conversation,
      proposedSpecs: (conversation.proposedSpecs ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, dismissedAt: now } : p)),
      updatedAt: now,
    }, `Dismissed the "${proposal.id}" spec proposal.`, now));
    res.json({ ok: true });
  };

  router.post('/:id/specs/:proposalId/dismiss', asyncRoute(dismissSpec));
  router.post('/:id/proposals/specs/:proposalId/dismiss', asyncRoute(dismissSpec));

  const acceptEscalation = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedEscalations ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });

    const now = new Date().toISOString();
    proposal.status = 'accepted';
    proposal.acceptedAt = now;
    conversation.isEscalated = true;
    conversation.escalatedScope = proposal.scope;
    if (proposal.namespaces) {
      conversation.escalatedNamespaces = proposal.namespaces;
    }
    conversation.updatedAt = now;

    await db.saveConversation(withConversationNotice(conversation, `Granted ${proposal.scope} access.`, now));
    res.json({ ok: true, conversation });
  };

  const denyEscalation = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedEscalations ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });

    const now = new Date().toISOString();
    proposal.status = 'denied';
    proposal.deniedAt = now;
    conversation.updatedAt = now;

    await db.saveConversation(withConversationNotice(conversation, 'Denied the privilege escalation request.', now));
    res.json({ ok: true, conversation });
  };

  router.post('/:id/escalations/:proposalId/accept', asyncRoute(acceptEscalation));
  router.post('/:id/proposals/escalations/:proposalId/accept', asyncRoute(acceptEscalation));
  router.post('/:id/escalations/:proposalId/deny', asyncRoute(denyEscalation));
  router.post('/:id/proposals/escalations/:proposalId/deny', asyncRoute(denyEscalation));

  const submitSecret = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const request = (conversation.proposedSecretRequests ?? []).find((r) => r.id === req.params.requestId);
    if (!request) return res.status(404).json({ error: 'No such secret request' });

    const { value } = req.body ?? {};
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: 'Secret value is required.' });
    }

    const projectId = request.projectId || conversation.id;
    const secretReference = `secret://${projectId}/${request.key}`;

    if (deps.infisicalService) {
      await deps.infisicalService.setSecret(projectId, request.key, value.trim());
    }

    const now = new Date().toISOString();
    request.status = 'fulfilled';
    request.secretReference = secretReference;
    request.fulfilledAt = now;
    conversation.updatedAt = now;

    await db.saveConversation(withConversationNotice(conversation, `Provided the ${request.key} secret.`, now));
    res.json({ ok: true, request, secretReference, conversation });
  };

  const dismissSecret = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const request = (conversation.proposedSecretRequests ?? []).find((r) => r.id === req.params.requestId);
    if (!request) return res.status(404).json({ error: 'No such secret request' });

    const now = new Date().toISOString();
    request.status = 'dismissed';
    request.dismissedAt = now;
    conversation.updatedAt = now;

    await db.saveConversation(withConversationNotice(conversation, `Dismissed the request for ${request.key}.`, now));
    res.json({ ok: true, request, conversation });
  };

  router.post('/:id/secrets/:requestId/submit', asyncRoute(submitSecret));
  router.post('/:id/proposals/secrets/:requestId/submit', asyncRoute(submitSecret));
  router.post('/:id/secrets/:requestId/dismiss', asyncRoute(dismissSecret));
  router.post('/:id/proposals/secrets/:requestId/dismiss', asyncRoute(dismissSecret));

  return router;
}
