import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { runChatTurn } from '../lib/chat-runtime.js';
import { getPersonaPack, type PersonaPack } from '../lib/persona-pack.js';
import type { Database } from '../lib/db-interface.js';
import type { Persona } from '@koala/harness-types';
import type { ModelService } from '../services/ModelService.js';
import type { McpServer } from '../lib/mcp-registry.js';
import type { Conversation } from '../lib/conversations.js';
import type { SearchOutcome } from '../lib/web-tools.js';
import { historyForPrompt } from '../lib/koala-context.js';
import { enabledForSession } from '../lib/conversations.js';
import { resolveConfig } from '../lib/personas.js';
import { trimConversation } from '../lib/sandbox-tools.js';
import { openSse, sendFrame, endSse } from '../lib/sse.js';
import { v4 as uuidv4 } from 'uuid';
import { appendUserTurn, buildKoalaPrompt } from '../lib/chat-pack-context.js';
import { buildChatCompletionRequest } from '../lib/chat-pack-model-call.js';
import { makePackToolExecutor } from '../lib/chat-pack-tools.js';

/**
 * Persona-pack chat router — `POST /api/chat-pack/:packId`.
 *
 * Thin shell: the concerns it used to inline now live in testable submodules —
 *   - vault + context reset            → lib/chat-pack-context.ts
 *   - the provider request             → lib/chat-pack-model-call.ts
 *   - dispatching tools (MCP+koala)    → lib/chat-pack-tools.ts
 * The router resolves the pack/persona/model, opens SSE, and drives lib/chat-runtime.ts.
 */
export interface PersonaChatRouterDeps {
  db: Database;
  modelService: ModelService;
  resolvePersona: (userId: string, personaName: string) => Promise<Persona>;
  serversFor: (userId: string) => Promise<McpServer[]>;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
  pack?: (id: string) => PersonaPack;
}

export function personaChatRouter(deps: PersonaChatRouterDeps): Router {
  const { db, modelService } = deps;
  const packFor = deps.pack ?? getPersonaPack;
  const router = Router();

  router.post('/:packId', asyncRoute(async (req, res) => {
    const userId = (req as any).user.id;
    const pack = packFor(String(req.params.packId));

    const { conversationId, message, sessionId, modelId } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Resolve the persona this pack is about, and the model endpoint.
    const personaName = typeof pack.persona === 'string' ? pack.persona : pack.persona.name;
    const persona = await deps.resolvePersona(userId, personaName);
    const servers = await deps.serversFor(userId);
    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(userId, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    // Vault: find or create the conversation; append the user turn (context policy submodule).
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
    const resolved = resolveConfig(await db.getHarnessProfile(userId), persona, {});
    const systemPrompt = resolved.systemPrompt ?? persona.systemPrompt ?? '';
    const thread = appendUserTurn(conversation, message, now);
    await db.saveConversation(thread);

    // SSE + the engine, wired to the extracted submodules.
    openSse(res);

    const call = async (reqBody: { messages: unknown[]; tools: string[]; toolChoice?: 'none' }) => {
      const body = buildChatCompletionRequest({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(provider ? { provider } : {}),
        messages: reqBody.messages as any[],
        tools: reqBody.tools,
        overrides: resolved.overrides,
        ...(reqBody.toolChoice === 'none' ? { toolChoice: 'none' as const } : {}),
      });
      return fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body as any),
      });
    };

    const executeTool = makePackToolExecutor({
      db, userId, conversationId: conversation.id, sessionId,
      enabledNames: enabled, servers,
      webSearch: deps.webSearch, fetchWebPage: deps.fetchWebPage,
      toolRefused: deps.toolRefused,
    });

    const historyMsgs: Array<{ role: string; content: string }> = historyForPrompt(thread.messages as any)
      .map((m: any) => ({ role: String(m.role), content: String(m.content) }));
    const result = await runChatTurn({
      pack,
      messages: [
        { role: 'system', content: buildKoalaPrompt(systemPrompt, servers, enabled) },
        ...historyMsgs,
      ],
      tools: enabled,
      call,
      executeTool,
      trimPerRound: (m: unknown[]) => trimConversation(m as any),
    });

    for (const frame of result.frames) sendFrame(res, frame as any);
    endSse(res);
  }));

  return router;
}