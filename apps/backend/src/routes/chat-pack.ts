import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { runChatTurn } from '../lib/chat-runtime.js';
import type { StreamEvent, PostPass } from '../lib/round-loop.js';
import { ThoughtFeatureExtractor, predictFailure, updateModelProfile } from '../lib/thinking-classifier.js';
import type { PersonaPack } from '@koala/harness-types';
import { ToolService } from '../services/ToolService.js';
import type { Database } from '../lib/db-interface.js';
import type { Persona } from '@koala/harness-types';
import type { ModelService } from '../services/ModelService.js';
import type { McpServer } from '../lib/mcp-registry.js';
import type { Conversation, ProposedTree, ProposedSpec } from '../lib/conversations.js';
import type { SearchOutcome } from '../lib/web-tools.js';
import { historyForPrompt } from '../lib/koala-context.js';
import { enabledForSession, titleFrom } from '../lib/conversations.js';
import { withConversationNotice } from '../lib/conversation-notice.js';
import { resolvePrompt } from '../lib/personas.js';
import { trimConversation, conversationBudget } from '../lib/sandbox-tools.js';
import { openSse, sendFrame, endSse } from '../lib/sse.js';
import { v4 as uuidv4 } from 'uuid';
import { appendUserTurn } from '../lib/chat-pack-context.js';
import { composePersonaPrompt } from '../lib/persona-prompt.js';
import { buildChatCompletionRequest } from '../lib/chat-pack-model-call.js';
import { makePackToolExecutor } from '../lib/chat-pack-tools.js';
import { schemasFor } from '../lib/tool-catalogue.js';
import { toLoopTools } from '../lib/mcp-tools.js';
import { validateSpec, explainSpecProblems } from '../lib/app-spec-validate.js';
import { visibleAppSpecs, type AppSpec } from '../lib/app-spec.js';
import { normaliseTreeInput } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import type { PersonaPackService } from '../services/PersonaPackService.js';

import { bootstrapAcceptedTree } from '../lib/tree-bootstrap.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { ClusterService } from '../services/ClusterService.js';

export interface PersonaChatRouterDeps {
  db: Database;
  packs: PersonaPackService;
  modelService: ModelService;
  projectRepoService?: ProjectRepoService;
  temporalBridge?: TemporalBridge;
  infraService?: InfrastructureService;
  infisicalService?: InfisicalService;
  clusterService?: Pick<ClusterService, 'getById' | 'getAll'>;
  jwtSecret?: string;
  serversFor: (userId: string) => Promise<McpServer[]>;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
}

export function personaChatRouter(deps: PersonaChatRouterDeps): Router {
  const { db, modelService, packs } = deps;
  const packFor = async (userId: string, id: string) =>
    packs.resolvePack(userId, id);
  const personaFor = async (userId: string, personaId: string) =>
    packs.resolvePersona(userId, personaId);
  const router = Router();

  router.get('/conversations', asyncRoute(async (req, res) => {
    const mine = await deps.ownedConversations((req as any).user.id);
    res.json(mine
      .map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
  }));

  router.get('/conversations/:id', asyncRoute(async (req, res) => {
    const found = (await deps.ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    res.json(found);
  }));

  router.post('/conversations', asyncRoute(async (req, res) => {
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

  router.delete('/conversations/:id', asyncRoute(async (req, res) => {
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

  router.post('/conversations/:id/trees/:proposalId/accept', asyncRoute(acceptTree));
  router.post('/conversations/:id/proposals/:proposalId/accept', asyncRoute(acceptTree));
  router.post('/conversations/:id/trees/:proposalId/dismiss', asyncRoute(dismissTree));
  router.post('/conversations/:id/proposals/:proposalId/dismiss', asyncRoute(dismissTree));

  router.post('/conversations/:id/specs/:proposalId/accept', asyncRoute(async (req, res) => {
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

  router.post('/conversations/:id/specs/:proposalId/dismiss', asyncRoute(dismissSpec));
  router.post('/conversations/:id/proposals/specs/:proposalId/dismiss', asyncRoute(dismissSpec));

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

  router.post('/conversations/:id/escalations/:proposalId/accept', asyncRoute(acceptEscalation));
  router.post('/conversations/:id/proposals/escalations/:proposalId/accept', asyncRoute(acceptEscalation));
  router.post('/conversations/:id/escalations/:proposalId/deny', asyncRoute(denyEscalation));
  router.post('/conversations/:id/proposals/escalations/:proposalId/deny', asyncRoute(denyEscalation));

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

  router.post('/conversations/:id/secrets/:requestId/submit', asyncRoute(submitSecret));
  router.post('/conversations/:id/proposals/secrets/:requestId/submit', asyncRoute(submitSecret));
  router.post('/conversations/:id/secrets/:requestId/dismiss', asyncRoute(dismissSecret));
  router.post('/conversations/:id/proposals/secrets/:requestId/dismiss', asyncRoute(dismissSecret));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;

    const { conversationId, message, sessionId, modelId } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Koala is the one named, permanent exception to "the pack is always the tree type's role" —
    // general conversation has no tree, so there is nothing else it could be. No longer a request
    // param: general chat never lets a caller pick which pack it runs as.
    const pack = await packFor(userId, 'koala');
    if (!pack) return res.status(404).json({ error: 'No koala pack found — run the seeder.' });

    const persona = await personaFor(userId, pack.personaId);
    if (!persona) {
      return res.status(409).json({
        error: `The pack "${pack.name}" points at a persona that no longer exists. `
          + 'Open it and choose one.',
      });
    }

    const servers = await deps.serversFor(userId);

    const systemPromptText = resolvePrompt(persona);

    const now = new Date().toISOString();
    let conversation = (await deps.ownedConversations(userId)).find((c) => c.id === String(conversationId));

    /**
     * What the caller asked for, else what this conversation last ran on. A conversation that was
     * pinned to an engine keeps it — reopening it a week later must not quietly move it onto
     * whatever the account now defaults to.
     */
    const chosenModel = typeof modelId === 'string' && modelId
      ? modelId
      : conversation?.modelId;

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(
        userId,
        chosenModel,
        pack.model?.endpointId,
      ));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    if (!conversation) {
      conversation = {
        id: String(conversationId ?? uuidv4()),
        ownerId: userId,
        title: 'New conversation',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    // Only an explicit pick sticks; inheriting the default must not silently become a pin.
    if (typeof modelId === 'string' && modelId) conversation.modelId = modelId;

    const enabled = enabledForSession(conversation, sessionId);
    const systemPrompt = systemPromptText ?? persona.systemPrompt ?? '';
    const thread = appendUserTurn(pack.budget, conversation, message, now);
    await db.saveConversation(thread);

    openSse(res);

    const toolRegistry = await new ToolService(db).list(userId);
    const ownTools = schemasFor(toolRegistry, pack.tools);

    const toolsFor = (enabledNames: string[]) => {
      const remote = servers
        .filter((s) => enabledNames.includes(s.name))
        .flatMap((s) => toLoopTools(s.name, s.tools));
      return [...ownTools, ...remote];
    };

    const call = async (reqBody: { messages: unknown[]; tools: string[]; toolChoice?: 'none' }) => {
      const toolSchemas = toolsFor(reqBody.tools);
      const body = buildChatCompletionRequest({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(provider ? { provider } : {}),
        messages: reqBody.messages as any[],
        tools: toolSchemas as any,
        ...(pack.sampling ? { sampling: pack.sampling } : {}),
        budget: pack.budget,
        ...(reqBody.toolChoice === 'none' ? { toolChoice: 'none' as const } : {}),
      });
      return fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body as any),
      });
    };

    const user = (req as any).user ?? { id: userId, isAdmin: false };
    const activeToolNames = ownTools.map((t) => t.function.name);

    const executeTool = makePackToolExecutor({
      db, userId, conversationId: conversation.id, sessionId,
      enabledNames: enabled, servers,
      webSearch: deps.webSearch, fetchWebPage: deps.fetchWebPage,
      toolRefused: deps.toolRefused,
      isAdmin: Boolean(user.isAdmin),
      isEscalated: Boolean(conversation.isEscalated),
      ...(conversation.escalatedNamespaces ? { escalatedNamespaces: conversation.escalatedNamespaces } : {}),
      ...(deps.temporalBridge ? { temporalBridge: deps.temporalBridge } : {}),
      ...(deps.infisicalService ? { infisicalService: deps.infisicalService } : {}),
      ...(deps.clusterService ? { clusterService: deps.clusterService } : {}),
    });

    const historyMsgs: Array<{ role: string; content: string }> = historyForPrompt(thread.messages as any)
      .map((m: any) => ({ role: String(m.role), content: String(m.content) }));

    const historyChars = historyMsgs.reduce((sum, m) => sum + m.content.length, 0);
    const systemPromptContent = composePersonaPrompt(pack.budget, pack.prompt, systemPrompt, {
      toolRegistry,
      activeTools: activeToolNames,
      servers,
      enabledServers: enabled,
      historyChars,
      isAdmin: Boolean(user.isAdmin),
      isEscalated: Boolean(conversation.isEscalated),
      ...(conversation.escalatedNamespaces ? { escalatedNamespaces: conversation.escalatedNamespaces } : {}),
    });

    const targetModelId = provider.model ?? chosenModel ?? 'default-model';
    const globalProfile = await db.getModelThinkingProfile?.(targetModelId).catch(() => null) ?? undefined;
    const featureExtractor = new ThoughtFeatureExtractor(message);

    // Same monitor `chat.ts` runs, same pack-governed source — koala's own pack row, never the
    // request body. Was entirely absent here; a long koala reasoning trace had nothing watching it.
    const onStreamEvent = (ev: StreamEvent): string | void => {
      if (ev.kind === 'reasoning') featureExtractor.pushReasoning(ev.text);
      const features = featureExtractor.extract();
      const sensitivity = pack.overthinking?.sensitivity ?? 'medium';
      const threshold = pack.overthinking?.failureThreshold ?? 0.65;
      const repeatCap = pack.overthinking?.ngramRepeatCap ?? 5;
      const pred = predictFailure(features, globalProfile, sensitivity, threshold, repeatCap);
      if (pred.shouldInterrupt) {
        return pred.reason ?? 'Overthinking loop detected';
      }
    };

    const postPasses: PostPass[] = [
      {
        id: 'length-continuation',
        when: (ctx) => ctx.finishReason === 'length',
        buildMessages: (ctx) => [
          ...ctx.originalMessages,
          { role: 'assistant', content: ctx.answer },
          { role: 'user', content: 'Continue your response from exactly where you left off.' },
        ],
      },
      {
        id: 'monologue-recovery',
        when: (ctx) => {
          const text = ctx.thinking || featureExtractor.getText();
          return !ctx.answer.trim() && Boolean(text) && text.length > 20;
        },
        buildMessages: (ctx) => {
          const text = ctx.thinking || featureExtractor.getText();
          return [
            ...ctx.originalMessages,
            { role: 'assistant', content: text },
            { role: 'user', content: 'Based on your thoughts above, now state your concise final answer directly to the user.' },
          ];
        },
      },
    ];

    const result = await runChatTurn({
      maxRounds: pack.budget.rounds,
      record: pack.budget.record,
      messages: [
        { role: 'system', content: systemPromptContent },
        ...historyMsgs,
      ],
      tools: enabled,
      call,
      executeTool,
      trimPerRound: (m: unknown[]) => trimConversation(m as any, conversationBudget(pack.budget, provider?.contextTokens)),
      onStreamEvent,
      postPasses,
      onFrame: (frame) => sendFrame(res, frame as any),
    });

    try {
      const finalFeatures = featureExtractor.extract();
      const profileOutcome = result.outcome.interrupted ? 'failure' : 'success';
      const updatedProfile = updateModelProfile(globalProfile, targetModelId, finalFeatures, profileOutcome);
      await db.saveModelThinkingProfile?.(updatedProfile);
    } catch { /* ignored */ }

    const ranDry = result.exhaustedRounds && !result.answer && !result.spoken;
    const fallback = `Used all tool rounds without reaching an answer. Ask again to continue.`;
    const assistantContent = result.answer || result.spoken || (ranDry ? fallback : '');

    const latestConv = (await db.getConversations()).find((c) => c.id === conversation.id) ?? thread;
    const assistantMsg: any = {
      role: 'assistant',
      content: assistantContent,
      at: new Date().toISOString(),
      ...(result.outcome.thinking?.trim() ? { reasoning: result.outcome.thinking.slice(-20000) } : {}),
      ...(result.outcome.enabledNow?.length ? { enabled: result.outcome.enabledNow } : {}),
      ...(result.outcome.toolCalls?.length ? { toolCalls: result.outcome.toolCalls } : {}),
      ...(ranDry ? { notice: true } : {}),
    };

    const nextProposedTrees = [...(latestConv.proposedTrees ?? [])];
    for (const p of result.outcome.proposedTrees ?? []) {
      if (p && typeof p === 'object' && 'id' in (p as any)) {
        if (!nextProposedTrees.some((x: any) => x.id === (p as any).id)) {
          nextProposedTrees.push(p as ProposedTree);
        }
      }
    }

    const nextProposedSpecs = [...(latestConv.proposedSpecs ?? [])];
    for (const s of result.outcome.proposedSpecs ?? []) {
      if (s && typeof s === 'object' && 'id' in (s as any)) {
        if (!nextProposedSpecs.some((x: any) => x.id === (s as any).id)) {
          nextProposedSpecs.push(s as ProposedSpec);
        }
      }
    }

    await db.saveConversation({
      ...latestConv,
      messages: [...latestConv.messages, assistantMsg],
      ...(nextProposedTrees.length ? { proposedTrees: nextProposedTrees } : {}),
      ...(nextProposedSpecs.length ? { proposedSpecs: nextProposedSpecs } : {}),
      updatedAt: new Date().toISOString(),
    });

    endSse(res);
  }));

  return router;
}