import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';
import type { Conversation } from '../lib/conversations.js';
import { titleFrom } from '../lib/conversations.js';
import { withConversationNotice } from '../lib/conversation-notice.js';
import { v4 as uuidv4 } from 'uuid';
import { validateSpec, explainSpecProblems } from '../lib/app-spec-validate.js';
import { visibleAppSpecs, type AppSpec } from '../lib/app-spec.js';
import { bootstrapAcceptedTree } from '../lib/tree-bootstrap.js';
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
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: uuidv4(),
      ownerId: (req as any).user.id,
      title: titleFrom(String(req.body?.title ?? '')),
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

  const acceptTree = async (req: any, res: any) => {
    const userId = req.user.id;
    const conversation = (await deps.ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedTrees ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.treeId) return res.status(409).json({ error: 'That project has already been created' });

    let nodeIp: string | undefined;
    if (deps.infraService) {
      try {
        nodeIp = (await deps.infraService.runKubectl(
          ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
          '/tmp/kubeconfig-provisioning-lunorica',
        )).trim();
      } catch {}
    }

    const bootstrapped = await bootstrapAcceptedTree({
      db,
      projectRepoService: deps.projectRepoService,
      temporalBridge: deps.temporalBridge,
      nodeIp,
      jwtSecret: deps.jwtSecret,
    }, {
      userId,
      proposal,
    });

    const now = new Date().toISOString();
    await db.saveConversation(withConversationNotice({
      ...conversation,
      proposedTrees: (conversation.proposedTrees ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, treeId: bootstrapped.tree.id } : p)),
      updatedAt: now,
    }, `Accepted the "${proposal.name}" tree.`, now));
    res.json({
      tree: bootstrapped.tree,
      branch: bootstrapped.branch,
      project: bootstrapped.project,
      planning: Boolean(bootstrapped.planWorkflowId),
    });
  };

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

  router.post('/:id/trees/:proposalId/accept', asyncRoute(acceptTree));
  router.post('/:id/proposals/:proposalId/accept', asyncRoute(acceptTree));
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
