import { Router, type Request } from 'express';
import { explainSpecProblems, validateSpec } from '../lib/app-spec-validate.js';
import type { AppSpec } from '../lib/app-spec.js';
import { MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_CALL_ARGS, MAX_TOOL_CALL_DIGEST, enabledForSession, titleFrom } from '../lib/conversations.js';
import type { Conversation, ProposedTree } from '../lib/conversations.js';
import { historyForPrompt, needsHandoff, trimKoalaThread, withHandoff } from '../lib/koala-context.js';
import { composePersonaPrompt } from '../lib/persona-prompt.js';
import { runToolRounds } from '../lib/round-loop.js';
import { runKoalaTool } from '../lib/koala-tool-runner.js';
import { KOALA_TOOLS } from '../lib/koala-tools.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { routeCall, toLoopTools } from '../lib/mcp-tools.js';
import { buildModelRequest } from '../lib/model-request.js';
import { resolveConfig } from '../lib/personas.js';
import type { Persona } from '../lib/personas.js';
import { MIN_TURN_TOKENS, fittedMaxTokens } from '../lib/sampling.js';
import { trimConversation } from '../lib/sandbox-tools.js';
import { endSse, openSse, sendFrame } from '../lib/sse.js';
import { normaliseTreeInput } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import type { McpServer } from '../lib/mcp-registry.js';
import type { Database } from '../lib/db-interface.js';
import type { ModelService } from '../services/ModelService.js';
import type { SearchOutcome } from '../lib/web-tools.js';
import type { InfisicalService } from '../services/InfisicalService.js';

import { bootstrapAcceptedTree } from '../lib/tree-bootstrap.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { recallMemories, markUsed } from '../lib/memory-recall.js';
import { corpusEndpoints } from '../lib/web-tools-resolver.js';

/**
 * Koala — the assistant that lives beside the platform, and the conversations it holds.
 *
 * ── MOVED VERBATIM ──
 * Nothing in here changed. The 461-line chat handler in particular is the single most
 * behaviour-sensitive route in the codebase: it speaks its own SSE envelope
 * (`{delta}` / `{reasoning}` / `{toolResult}`) which `lib/stream-delta.ts` and the chat pane parse
 * directly, and any re-encoding of those frames is a wire-format change wearing a refactor's
 * clothes. The consolidation with `/api/chat`'s round loop is a SEPARATE, later change, and
 * `koala.test.ts` exists to make that one safe rather than this one.
 *
 * ── WHY THE HELPERS ARE INJECTED AND NOT IMPORTED ──
 * `ensureKoala`, `ensurePersonas`, `koalaServers` and the web-tool executors are closures over
 * `db` and `modelService` in `bootstrap()`. They are passed in rather than reconstructed here
 * because several of them are shared with `/api/chat` and the leaf runner — two copies of
 * `ensureKoala` would mean two definitions of what the built-in assistant IS, and the seeding
 * would silently diverge per entry point.
 */

/** Room for a turn that inspects, enables a service and then answers. */
const KOALA_MAX_TOKENS = 8000;

/**
 * Ceiling on one remote tool's answer.
 *
 * A service returns whatever it likes, and an unbounded answer can leave `fittedMaxTokens` nothing
 * for the reply — a turn ending on `finish_reason: length` having said nothing.
 *
 * But trimming too hard is worse than not trimming. At 4000 the GitHub repository payload was cut
 * before `stargazers_count`, and the model — having noticed, and said so — answered from memory
 * instead: "well over 160,000 stars". A truncated tool result does not read as missing data to a
 * model, it reads as permission to fall back on what it already believes, and the user cannot tell
 * the difference.
 *
 * 12000 fits that payload whole against a measured prompt of ~6500 characters with the budget
 * untouched. The ceiling is for a runaway response, not for ordinary ones.
 */
const MAX_REMOTE_RESULT = 12000;

/**
 * Tool rounds per turn.
 *
 * Six was not enough, measured: a single question — "what services do you have, and look up
 * microsoft/vscode" — spent rounds on listing, enabling, and re-reading, and hit the cap with the
 * reply mid-sentence: "Now let me look up the microsoft/vscode repository for you:". The work was
 * right and the budget ended first.
 *
 * The sequence this has to fit is list → enable → call → answer, and a reasoning model spends a
 * round thinking between each. Twelve leaves room for that plus a mistake, and the loop still exits
 * the moment a round returns no tool calls, so an ordinary chat costs one.
 */
const KOALA_TOOL_ROUNDS = 12;

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface KoalaRouterDeps {
  db: Database;
  modelService: ModelService;
  projectRepoService?: ProjectRepoService;
  temporalBridge?: TemporalBridge;
  infraService?: InfrastructureService;
  infisicalService?: InfisicalService;
  jwtSecret?: string;
  ensureKoala: (userId: string) => Promise<Persona>;
  ensurePersonas: (userId: string) => Promise<void>;
  /** The user's MCP services with their tools, already deduped by `preferUsable`. */
  koalaServers: (userId: string) => Promise<McpServer[]>;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  executeWebSearch: (query: string) => Promise<SearchOutcome>;
  executeFetchWebPage: (url: string) => Promise<string>;
  /** Whether a tool result is a refusal, which the round loop treats as terminal. */
  toolRefused: (result: string) => boolean;
}

export function koalaRouter(deps: KoalaRouterDeps): Router {
  const router = Router();
  const {
    db, modelService, ensureKoala, ensurePersonas, koalaServers,
    ownedConversations, executeWebSearch, executeFetchWebPage, toolRefused,
  } = deps;

  router.get('/conversations', async (req, res) => {
    const mine = await ownedConversations((req as any).user.id);
    // Newest first, and without messages: the list renders titles, and a hundred threads of
    // transcript is a payload nobody asked for.
    res.json(mine
      .map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
  });

  router.get('/conversations/:id', async (req, res) => {
    const found = (await ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    res.json(found);
  });

  router.post('/conversations', async (req, res) => {
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
  });

  router.delete('/conversations/:id', async (req, res) => {
    const found = (await ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    await db.deleteConversation(found.id);
    res.json({ success: true });
  });

  /**
   * Accepting a proposed project.
   *
   * The tree is created HERE rather than when Koala proposed it — the whole point of a proposal is
   * that nothing exists until a person says so, and a casual question must not litter the Grove.
   * The proposal is kept and marked with what it became, so the card can link to it instead of
   * offering to create a second one.
   */
  router.post('/conversations/:id/proposals/:proposalId/accept', async (req, res) => {
    const userId = (req as any).user.id;
    const conversation = (await ownedConversations(userId)).find((c) => c.id === req.params.id);
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
  });

  /**
   * Accepting a proposed app type.
   *
   * Validated AGAIN here, not only when it was proposed. A proposal can sit for a week, and the
   * rules can change under it — a spec that was acceptable then and is not now must be refused at
   * the moment it would become real, which is this one.
   */
  router.post('/conversations/:id/specs/:proposalId/accept', async (req, res) => {
    const userId = (req as any).user.id;
    const conversation = (await ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedSpecs ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.acceptedAt) return res.status(409).json({ error: 'That app type already exists' });

    const problems = validateSpec(proposal.spec);
    if (problems.length) return res.status(400).json({ error: explainSpecProblems(problems) });

    /**
     * A replacement overwrites; a built-in never does.
     *
     * Built-ins ship with the platform and a test pins the list, so letting a conversation rewrite
     * one would have a fresh clone and a running instance disagreeing about what `minio` is.
     * Anything else is the user's own, and correcting it is the point.
     */
    const existing = (await db.getAppSpecs()).find((s) => s.id === proposal.id);
    if (existing?.builtIn) {
      return res.status(409).json({ error: `"${proposal.id}" ships with the platform and cannot be replaced.` });
    }

    const now = new Date().toISOString();
    await db.saveAppSpec({
      id: proposal.id,
      spec: proposal.spec as AppSpec,
      // Not built in: the repo does not manage it, and seeding must never touch it.
      builtIn: false,
      ownerId: userId,
      // Kept from the original: a spec being corrected is the same spec, and losing when it first
      // appeared would make the catalogue's history a lie.
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await db.saveConversation({
      ...conversation,
      proposedSpecs: (conversation.proposedSpecs ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, acceptedAt: now } : p)),
      updatedAt: now,
    });
    console.log(`[app-specs] ${userId.slice(0, 8)} accepted a new app type: ${proposal.id}`);
    res.json({ id: proposal.id });
  });

  const acceptKoalaEscalation = async (req: any, res: any) => {
    const userId = userOf(req).id;
    const conversation = (await db.getConversations()).find(
      (c) => c.id === req.params.id && c.ownerId === userId,
    );
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

  const denyKoalaEscalation = async (req: any, res: any) => {
    const userId = userOf(req).id;
    const conversation = (await db.getConversations()).find(
      (c) => c.id === req.params.id && c.ownerId === userId,
    );
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

  router.post('/conversations/:id/escalations/:proposalId/accept', acceptKoalaEscalation);
  router.post('/conversations/:id/proposals/escalations/:proposalId/accept', acceptKoalaEscalation);
  router.post('/conversations/:id/escalations/:proposalId/deny', denyKoalaEscalation);
  router.post('/conversations/:id/proposals/escalations/:proposalId/deny', denyKoalaEscalation);

  const submitKoalaSecret = async (req: any, res: any) => {
    const userId = userOf(req).id;
    const conversation = (await db.getConversations()).find(
      (c) => c.id === req.params.id && c.ownerId === userId,
    );
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

  const denyKoalaSecret = async (req: any, res: any) => {
    const userId = userOf(req).id;
    const conversation = (await db.getConversations()).find(
      (c) => c.id === req.params.id && c.ownerId === userId,
    );
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

  router.post('/conversations/:id/secrets/:requestId/submit', submitKoalaSecret);
  router.post('/conversations/:id/proposals/secrets/:requestId/submit', submitKoalaSecret);
  router.post('/conversations/:id/secrets/:requestId/dismiss', denyKoalaSecret);
  router.post('/conversations/:id/proposals/secrets/:requestId/dismiss', denyKoalaSecret);

  /**
   * One general-chat turn.
   *
   * ── WHY THE TOOL ROUNDS ARE NOT STREAMED ──
   * Only the final answer is. A tool round produces no prose worth watching arrive — it produces a
   * function call — and streaming it means reassembling tool_calls from deltas, which is the fiddly
   * part of the branch route. The visible result is the same and the failure modes are far fewer.
   */
  router.post('/chat', async (req, res) => {
    const user = (req as any).user;
    const userId = user.id;
    const { conversationId, message, sessionId, modelId } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    let conversation = (await ownedConversations(userId)).find((c) => c.id === String(conversationId));
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });

    await ensurePersonas(userId);
    const persona = await ensureKoala(userId);
    /**
     * The same resolution chain the branch route uses: adopted profile, then persona, then request.
     *
     * Sending `overrides: {}` instead produced a turn that reasoned for 365 characters and returned
     * NOTHING — no content and no tool calls, `finish_reason: stop`, with the budget untouched. The
     * knobs that make a reasoning model split its thinking from its answer live in this chain, and
     * without them it thinks and stops.
     */
    const resolved = resolveConfig(await db.getHarnessProfile(userId), persona, {});
    const servers = await koalaServers(userId);
    // Servers this session already hooked up keep their tools without being re-enabled.
    let enabled = enabledForSession(conversation, sessionId);

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(userId, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    const now = new Date().toISOString();

    const toolsFor = (names: string[]) => {
      const remote = servers
        .filter((s) => names.includes(s.name))
        .flatMap((s) => toLoopTools(s.name, s.tools));
      return [...KOALA_TOOLS, ...remote];
    };

    /**
     * Reset the thread if this turn would not fit — BEFORE the new message is appended.
     *
     * Before, so the notice lands ahead of the message rather than having to be spliced in behind
     * it, and so the reload path sees the same order. `message.length` is counted explicitly for
     * the same reason: it is not in the array yet, and being one message out here is precisely the
     * difference between resetting and hitting the engine's refusal.
     *
     * See lib/koala-context.ts for why the artifact is assembled rather than summarised, and why
     * the threshold is 0.55 rather than something closer to full.
     */
    const userMemories = await db.getMemories(user.id).catch(() => []);
    const recalled = await recallMemories({
      memories: userMemories,
      ownerId: user.id,
      query: message,
      endpoints: () => corpusEndpoints(db, user.id).catch(() => undefined),
    }).catch(() => ({ context: '', selected: [], via: 'recency' as const }));

    if (recalled.selected.length) {
      void markUsed(db, recalled.selected);
    }

    {
      const enabledNow = enabledForSession(conversation, sessionId);
      const promptNow = JSON.stringify([
        {
          role: 'system',
          content: composePersonaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', {
            servers,
            enabledServers: enabledNow,
            isAdmin: Boolean(user.isAdmin),
            isEscalated: Boolean(conversation!.isEscalated),
            ...(conversation!.escalatedNamespaces ? { escalatedNamespaces: conversation!.escalatedNamespaces } : {}),
            ...(recalled.context ? { memoryContext: recalled.context } : {}),
          }),
        },
        ...historyForPrompt(conversation.messages).map((m) => ({ role: m.role, content: m.content })),
      ]).length + JSON.stringify(toolsFor(enabledNow)).length;

      if (needsHandoff(promptNow, message.length)) {
        conversation = { ...conversation, messages: withHandoff(conversation, now) };
        console.log(`[koala] context reset for conversation ${conversation.id.slice(0, 8)}`);
      }
    }

    conversation = {
      ...conversation,
      // Named from the first thing said, so the list never shows a row of "New conversation".
      title: conversation.messages.length === 0 ? titleFrom(message) : conversation.title,
      messages: trimKoalaThread([...conversation.messages, { role: 'user' as const, content: message, at: now }]),
      updatedAt: now,
    };
    await db.saveConversation(conversation);

    const toolRegistry = await db.getTools();
    const historyMsgs = historyForPrompt(conversation!.messages).map((m) => ({ role: m.role, content: m.content }));
    const historyChars = historyMsgs.reduce((sum, m) => sum + m.content.length, 0);

    /**
     * Sliced at the last handoff, so a reset thread does not silently keep paying for the messages
     * it just summarised. With no handoff this is the whole conversation, unchanged.
     */
    const conversationFor = (list: string[]) => [
      {
        role: 'system',
        content: composePersonaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', {
          toolRegistry,
          activeTools: KOALA_TOOLS.map((t) => t.function.name),
          servers,
          enabledServers: list,
          historyChars,
          isAdmin: Boolean(user.isAdmin),
          isEscalated: Boolean(conversation!.isEscalated),
          ...(conversation!.escalatedNamespaces ? { escalatedNamespaces: conversation!.escalatedNamespaces } : {}),
          ...(recalled.context ? { memoryContext: recalled.context } : {}),
        }),
      },
      ...historyMsgs,
    ];

    const upstreamAbort = new AbortController();
    res.on('close', () => upstreamAbort.abort());

    /**
     * What this turn will actually put in the window: the messages AND the tool schemas.
     *
     * The tools were not being counted, and they are not a rounding error — KOALA_TOOLS alone is
     * roughly 8KB of JSON, and every MCP server enabled for the session adds its whole schema set
     * on top. So the estimate was worst precisely when the prompt was largest, and it under-read by
     * more the more services a user had hooked up. Both the reply budget and the pressure check
     * below are only as honest as this number.
     */
    const promptCharsFor = (messages: unknown, names: string[]) =>
      JSON.stringify(messages).length + JSON.stringify(toolsFor(names)).length;

    const call = async (
      messages: unknown,
      stream: boolean,
      names: string[],
      extra?: Record<string, unknown>,
    ) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(buildModelRequest({
        /**
         * ── 'tool-turn', NOT 'conversation', AND IT IS NOT A STYLE CHOICE ──
         * `conversationSampling` carries frequency_penalty 0.4 and presence_penalty 0.3, and
         * exp-penalties-001 measured those scoring 0/12 on tool calling against 12/12 without —
         * perfect separation across two tasks and two prompts, with the failing runs making ZERO
         * tool calls. The mechanism is plain: emitting a call means reproducing the function names
         * and JSON keys already in the prompt, and these penalties push away from exactly those
         * tokens. It gets worse with more tools, and this turn offers eleven plus every MCP tool
         * the session has enabled — the worst case that experiment describes.
         *
         * `toolTurnSampling` drops them and keeps DRY on TabbyAPI, which the same experiment found
         * innocent (3/3 with DRY alone). What it also does is pin temperature at 0.3, which is
         * wrong here — so the persona carries KOALA_TEMPERATURE and `resolved.overrides` puts it
         * back, below anything the user set in the Lab.
         */
        turn: 'tool-turn',
        ...(provider!.kind ? { kind: provider!.kind } : {}),
        messages,
        tools: toolsFor(names),
        stream,
        maxTokens: fittedMaxTokens(KOALA_MAX_TOKENS, promptCharsFor(messages, names)),
        ...(provider!.model ? { model: provider!.model } : {}),
        overrides: resolved.overrides,
        ...(extra ? { extra } : {}),
      }).body),
      signal: upstreamAbort.signal,
    });

    try {
      openSse(res);

      /**
       * ── ON THE SHARED ROUND LOOP ──
       * The hand-written round loop was consolidated into lib/round-loop.ts's `runToolRounds` —
       * the same machine /api/chat runs. This handler's job is now the callbacks, and the ENVELOPE
       * stays koala's own: upstream provider frames are re-encoded as {delta}/{reasoning}/
       * {toolCall}/{toolResult} exactly as before, pinned by routes/chat-wire.test.ts.
       */

      // The session's enabled services, widened as a tool enables one mid-turn. Mirrors the
      // loop's own toolNames so routeCall stays in step.
      const enabledNames = [...enabled];
      const turned = conversationFor(enabledNames);

      const loopCall = async (req: { messages: any[]; tools: string[]; toolChoice?: 'none' }) => {
        // Rebuild the system prompt from the live tool set, so an enabled service's catalogue is
        // present on the next round — the loop widened `req.tools` via onEnabled.
        const sysFor = (names: string[]) =>
          composePersonaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', {
            toolRegistry,
            activeTools: KOALA_TOOLS.map((t) => t.function.name),
            servers,
            enabledServers: names,
            historyChars,
            isAdmin: Boolean(user.isAdmin),
            isEscalated: Boolean(conversation!.isEscalated),
            ...(conversation!.escalatedNamespaces ? { escalatedNamespaces: conversation!.escalatedNamespaces } : {}),
          });
        const msgs = req.messages.map((m: any, i: number) =>
          i === 0 && m.role === 'system' ? { ...m, content: sysFor(req.tools) } : m);

        // Refuse before the engine does, with something the reader can act on. The same guard the
        // inline loop ran each round before calling.
        if (req.toolChoice !== 'none' &&
            fittedMaxTokens(KOALA_MAX_TOKENS, promptCharsFor(msgs, req.tools)) <= MIN_TURN_TOKENS) {
          sendFrame(res, {
            error: 'This conversation has outgrown the model\'s context window. Start a new one to keep going — '
              + 'the trees and specs you have already accepted are safe.',
          });
          return { ok: false, status: 400 };
        }

        return call(msgs, true, req.tools, req.toolChoice === 'none' ? { tool_choice: 'none' } : undefined);
      };

      /** Maps a raw StreamEvent to koala's wire envelope. */
      const emit = (frame: any) => {
        if (frame.kind === 'content') sendFrame(res, { delta: frame.text });
        else if (frame.kind === 'reasoning') sendFrame(res, { reasoning: frame.text });
        else if (frame.kind === 'toolCall') sendFrame(res, { toolCall: { id: frame.id, name: frame.name, args: frame.args } });
        else if (frame.kind === 'toolResult') sendFrame(res, { toolResult: { id: frame.id, ok: frame.ok, digest: frame.digest } });
      };

      /** A service enabled this turn widens the NEXT round's tools, told to the reader now. */
      const onEnabled = (name: string) => {
        if (!enabledNames.includes(name)) enabledNames.push(name);
        sendFrame(res, { enabled: [name] });
      };

      const executeTool = async (c: { id: string; name: string; arguments: string }) => {
        // Remote tools route to their service; everything else is Koala's own.
        const route = routeCall(c.name, enabledNames);
        if (route) {
          const server = servers.find((sv) => sv.name === route.server);
          let text: string;
          try {
            const registry = new McpRegistryService(db, userId, (n: string) => resolveMcpProbeUrl(n));
            const got = server
              ? await registry.call(server, route.tool, JSON.parse(c.arguments || '{}'))
              : { text: `"${route.server}" is no longer running.`, isError: true };
            text = got.text;
          } catch (err: any) {
            text = `That call failed: ${String(err?.message ?? err).slice(0, 200)}`;
          }
          const trimmed = text.length > MAX_REMOTE_RESULT
            ? `${text.slice(0, MAX_REMOTE_RESULT)}\n…[trimmed, ${text.length} characters total]`
            : text;
          return { content: trimmed, ok: !toolRefused(trimmed) };
        }

        const out = await runKoalaTool(
          {
            db, userId, conversationId: conversation!.id, sessionId,
            servers, webSearch: executeWebSearch, fetchWebPage: executeFetchWebPage,
            /** Read-only, arg-array-only — nothing a model writes reaches a shell. */
            kubectl: (a: string[]) => new InfrastructureService().runKubectl(a).then((r: any) =>
              typeof r === 'string' ? r : (r?.stdout ?? '')),
            temporalBridge: deps.temporalBridge,
            infisicalService: deps.infisicalService,
            isAdmin: Boolean(user.isAdmin),
            isEscalated: Boolean(conversation!.isEscalated),
            ...(conversation!.escalatedNamespaces ? { escalatedNamespaces: conversation!.escalatedNamespaces } : {}),
          },
          { name: c.name, arguments: c.arguments },
        );
        return {
          content: out.content,
          ok: !toolRefused(out.content),
          ...(out.enabled ? { enabled: out.enabled } : {}),
          ...(out.proposed ? { proposed: out.proposed } : {}),
          ...(out.proposedSpec ? { proposedSpec: out.proposedSpec } : {}),
          ...(out.proposedEscalation ? { proposedEscalation: out.proposedEscalation } : {}),
          ...(out.proposedSecretRequest ? { proposedSecretRequest: out.proposedSecretRequest } : {}),
        };
      };

      const result = await runToolRounds({
        maxRounds: KOALA_TOOL_ROUNDS,
        messages: turned,
        tools: enabledNames,
        call: loopCall,
        emit,
        executeTool,
        onEnabled,
        onExhausted: 'wrap-up',
        trimPerRound: (msgs: any[]) => trimConversation(msgs),
        maxToolCallsPerMessage: MAX_TOOL_CALLS_PER_MESSAGE,
        maxToolCallArgs: MAX_TOOL_CALL_ARGS,
        maxToolCallDigest: MAX_TOOL_CALL_DIGEST,
      });

      // Proposals surface as cards; the original streamed them live, we flush the same frames.
      for (const pc of result.proposedTrees) sendFrame(res, { proposedTree: pc });
      for (const pc of result.proposedSpecs) sendFrame(res, { proposedSpec: pc });
      for (const pc of result.proposedEscalations) sendFrame(res, { proposedEscalation: pc });
      for (const ps of result.proposedSecretRequests) sendFrame(res, { proposedSecretRequest: ps });

      /**
       * Still nothing to show? Say so rather than persisting an empty bubble.
       */
      const ranDry = result.exhaustedRounds && !result.answer && !result.spoken;
      const fallback = `Koala used all ${KOALA_TOOL_ROUNDS} tool rounds without reaching an answer. `
        + 'Ask again and it will continue from what it found.';

      // Persisted after the stream, so a reader who disconnects mid-answer does not lose what the
      // model already said.
      const saved = (await db.getConversations()).find((c) => c.id === conversation!.id);
      if (saved) {
        await db.saveConversation({
          ...saved,
          messages: [...saved.messages, {
            role: 'assistant' as const,
            content: result.answer || result.spoken || fallback,
            at: new Date().toISOString(),
            ...(result.thinking.trim() ? { reasoning: result.thinking.slice(-20000) } : {}),
            ...(result.enabledNow.length ? { enabled: result.enabledNow } : {}),
            ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
            ...(ranDry ? { notice: true as const } : {}),
          }],
          updatedAt: new Date().toISOString(),
        });
      }
      endSse(res);
    } catch (err: any) {
      console.error(`[koala] turn failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
  });
  return router;
}
