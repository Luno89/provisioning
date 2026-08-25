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
import { buildKoalaPrompt } from '../lib/koala-persona.js';
import { historyForPrompt, trimKoalaThread, withHandoff, needsHandoff } from '../lib/koala-context.js';
import { enabledForSession, titleFrom } from '../lib/conversations.js';
import { resolveConfig } from '../lib/personas.js';
import { fittedMaxTokens } from '../lib/sampling.js';
import { buildModelRequest } from '../lib/model-request.js';
import { trimConversation } from '../lib/sandbox-tools.js';
import { openSse, sendFrame, endSse } from '../lib/sse.js';
import { runKoalaTool } from '../lib/koala-tool-runner.js';
import { routeCall } from '../lib/mcp-tools.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Persona-pack chat router — `POST /api/chat/:packId`.
 *
 * Turns any registered `PersonaPack` into a live chat turn, engine-backed by `lib/chat-runtime.ts`
 * and emitting the UNIFIED wire (`lib/chat-wire.ts`). Adding a conversational persona is registering
 * a pack, not writing a route. Additive: the old `/api/koala/chat` and `/api/chat` stay until the
 * frontend moves to a unified surface.
 */
export interface PersonaChatRouterDeps {
  db: Database;
  modelService: ModelService;
  /** Resolve the persona a pack's `persona` names to. */
  resolvePersona: (userId: string, personaName: string) => Promise<Persona>;
  /** The user's MCP services for `mcp:'session'` packs. */
  serversFor: (userId: string) => Promise<McpServer[]>;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
  /** Override the pack registry (default getPersonaPack). */
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

    // The persona this pack is about, and the model.
    const personaName = typeof pack.persona === 'string' ? pack.persona : pack.persona.name;
    const persona = await deps.resolvePersona(userId, personaName);
    const servers = await deps.serversFor(userId);
    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(userId, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    // Vault: find or create the conversation.
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
    await db.saveConversation(conversation);

    const enabled = enabledForSession(conversation, sessionId);
    const resolved = resolveConfig(await db.getHarnessProfile(userId), persona, {});
    const systemPrompt = resolved.systemPrompt ?? persona.systemPrompt ?? '';

    // Context reset (koala's vault policy) + append the user turn.
    let thread = conversation;
    if (needsHandoff(
      JSON.stringify([{ role: 'system', content: buildKoalaPrompt(systemPrompt, servers, enabled) },
        ...historyForPrompt(conversation.messages).map((m) => ({ role: m.role, content: m.content }))]).length,
      message.length,
    )) {
      thread = { ...thread, messages: withHandoff(thread, now) };
    }
    thread = {
      ...thread,
      title: thread.messages.length === 0 ? titleFrom(message) : thread.title,
      messages: trimKoalaThread([...thread.messages, { role: 'user', content: message, at: now }]),
      updatedAt: now,
    };
    await db.saveConversation(thread);

    // Names of the tools offered this round: the session-enabled MCP services.
    const toolNames = [...enabled];

    // Open the SSE stream.
    openSse(res);

    // The model call (the round loop's `call`).
    const call = async (reqBody: { messages: unknown[]; tools: string[]; toolChoice?: 'none' }) => {
      const body = buildModelRequest({
        turn: 'tool-turn',
        ...(provider?.kind ? { kind: provider.kind } : {}),
        messages: reqBody.messages as any,
        tools: reqBody.tools as unknown as any[],
        stream: true,
        maxTokens: fittedMaxTokens(16000, JSON.stringify(reqBody.messages).length),
        ...(provider?.model ? { model: provider.model } : {}),
        overrides: resolved.overrides,
        ...(reqBody.toolChoice === 'none' ? { extra: { tool_choice: 'none' } } : {}),
      });
      return fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body as any),
      });
    };

    // Tool dispatch: MCP names first, then koala's chain.
    const executeTool = async (c: { id: string; name: string; arguments: string }) => {
      const route = routeCall(c.name, toolNames);
      if (route) {
        const server = servers.find((s) => s.name === route.server);
        let text: string;
        try {
          const got = server
            ? await new McpRegistryService(db, userId, (n: string) => resolveMcpProbeUrl(n)).call(server, route.tool, JSON.parse(c.arguments || '{}'))
            : { text: `"${route.server}" is no longer running.` };
          text = got.text ?? '';
        } catch (err: any) { text = `That call failed: ${String(err?.message ?? err).slice(0, 200)}`; }
        return { content: text, ok: !deps.toolRefused(text) };
      }
      const out = await runKoalaTool(
        { db, userId, conversationId: conversation.id, sessionId, servers, webSearch: deps.webSearch, fetchWebPage: deps.fetchWebPage,
          kubectl: (a: string[]) => new InfrastructureService().runKubectl(a).then((r: any) => typeof r === 'string' ? r : (r?.stdout ?? '')) },
        { name: c.name, arguments: c.arguments },
      );
      return { content: out.content, ok: !deps.toolRefused(out.content),
        ...(out.enabled ? { enabled: out.enabled } : {}),
        ...(out.proposed ? { proposed: out.proposed } : {}),
        ...(out.proposedSpec ? { proposedSpec: out.proposedSpec } : {}) };
    };

    const historyMsgs: Array<{ role: string; content: string }> = historyForPrompt(thread.messages as any).map((m: any) => ({ role: String(m.role), content: String(m.content) }));
    const result = await runChatTurn({
      pack,
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMsgs,
      ],
      tools: toolNames,
      call,
      executeTool,
      trimPerRound: (m: unknown[]) => trimConversation(m as any),
    });

    // Emit the delivery-filtered unified frames.
    for (const frame of result.frames) sendFrame(res, frame as any);
    endSse(res);
  }));

  return router;
}