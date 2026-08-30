import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { runChatTurn } from '../lib/chat-runtime.js';
import type { PersonaPack } from '@koala/harness-types';
import { ownedBy } from '../lib/ownership.js';
import { ToolService } from '../services/ToolService.js';
import type { Database } from '../lib/db-interface.js';
import type { Persona } from '@koala/harness-types';
import type { ModelService } from '../services/ModelService.js';
import type { McpServer } from '../lib/mcp-registry.js';
import type { Conversation, ProposedTree, ProposedSpec } from '../lib/conversations.js';
import type { SearchOutcome } from '../lib/web-tools.js';
import { historyForPrompt } from '../lib/koala-context.js';
import { enabledForSession, titleFrom } from '../lib/conversations.js';
import { resolveConfig } from '../lib/personas.js';
import { trimConversation } from '../lib/sandbox-tools.js';
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

import { bootstrapAcceptedTree } from '../lib/tree-bootstrap.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { InfisicalService } from '../services/InfisicalService.js';

export interface PersonaChatRouterDeps {
  db: Database;
  modelService: ModelService;
  projectRepoService?: ProjectRepoService;
  temporalBridge?: TemporalBridge;
  infraService?: InfrastructureService;
  infisicalService?: InfisicalService;
  jwtSecret?: string;
  personaFor: (userId: string, personaId: string) => Promise<Persona | undefined>;
  serversFor: (userId: string) => Promise<McpServer[]>;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
  pack?: (userId: string, id: string) => Promise<PersonaPack | undefined>;
}

export function personaChatRouter(deps: PersonaChatRouterDeps): Router {
  const { db, modelService } = deps;
  const packFor = deps.pack ?? (async (userId: string, id: string) =>
    ownedBy(await db.getPersonaPacks(), userId).find((p) => p.id === id || p.slug === id));
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
    await db.saveConversation({
      ...conversation,
      proposedTrees: (conversation.proposedTrees ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, treeId: bootstrapped.tree.id } : p)),
      updatedAt: now,
    });
    res.json({
      tree: bootstrapped.tree,
      branch: bootstrapped.branch,
      leaf: bootstrapped.leaf,
      project: bootstrapped.project,
    });
  };

  router.post('/conversations/:id/trees/:proposalId/accept', asyncRoute(acceptTree));
  router.post('/conversations/:id/proposals/:proposalId/accept', asyncRoute(acceptTree));

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
    await db.saveConversation({
      ...conversation,
      proposedSpecs: (conversation.proposedSpecs ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, acceptedAt: now } : p)),
      updatedAt: now,
    });
    res.json({ id: proposal.id });
  }));

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

    await db.saveConversation(conversation);
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

    await db.saveConversation(conversation);
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

    await db.saveConversation(conversation);
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

    await db.saveConversation(conversation);
    res.json({ ok: true, request, conversation });
  };

  router.post('/conversations/:id/secrets/:requestId/submit', asyncRoute(submitSecret));
  router.post('/conversations/:id/proposals/secrets/:requestId/submit', asyncRoute(submitSecret));
  router.post('/conversations/:id/secrets/:requestId/dismiss', asyncRoute(dismissSecret));
  router.post('/conversations/:id/proposals/secrets/:requestId/dismiss', asyncRoute(dismissSecret));

  router.post('/:packId', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;

    const { conversationId, message, sessionId, modelId } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const pack = await packFor(userId, String(req.params.packId));
    if (!pack) return res.status(404).json({ error: `No pack "${String(req.params.packId)}"` });

    const persona = await deps.personaFor(userId, pack.personaId);
    if (!persona) {
      return res.status(409).json({
        error: `The pack "${pack.name}" points at a persona that no longer exists. `
          + 'Open it and choose one.',
      });
    }

    const servers = await deps.serversFor(userId);

    const resolved = resolveConfig(await db.getHarnessProfile(userId), pack, {}, persona);
    const chosenModel = modelId ?? resolved.overrides.model;

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(
        userId,
        typeof chosenModel === 'string' ? chosenModel : undefined,
      ));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    const now = new Date().toISOString();
    let conversation = (await deps.ownedConversations(userId)).find((c) => c.id === String(conversationId));
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

    const enabled = enabledForSession(conversation, sessionId);
    const systemPrompt = resolved.systemPrompt ?? persona.systemPrompt ?? '';
    const thread = appendUserTurn(conversation, message, now);
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
        overrides: resolved.overrides,
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
    });

    const historyMsgs: Array<{ role: string; content: string }> = historyForPrompt(thread.messages as any)
      .map((m: any) => ({ role: String(m.role), content: String(m.content) }));

    const historyChars = historyMsgs.reduce((sum, m) => sum + m.content.length, 0);
    const systemPromptContent = composePersonaPrompt(systemPrompt, {
      toolRegistry,
      activeTools: activeToolNames,
      servers,
      enabledServers: enabled,
      historyChars,
      isAdmin: Boolean(user.isAdmin),
      isEscalated: Boolean(conversation.isEscalated),
      ...(conversation.escalatedNamespaces ? { escalatedNamespaces: conversation.escalatedNamespaces } : {}),
    });

    const result = await runChatTurn({
      messages: [
        { role: 'system', content: systemPromptContent },
        ...historyMsgs,
      ],
      tools: enabled,
      call,
      executeTool,
      trimPerRound: (m: unknown[]) => trimConversation(m as any),
      onFrame: (frame) => sendFrame(res, frame as any),
    });

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