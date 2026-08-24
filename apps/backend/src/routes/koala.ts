import { Router, type Request } from 'express';
import { explainSpecProblems, validateSpec } from '../lib/app-spec-validate.js';
import type { AppSpec } from '../lib/app-spec.js';
import { MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_CALL_ARGS, MAX_TOOL_CALL_DIGEST, enabledForSession, titleFrom } from '../lib/conversations.js';
import type { Conversation, ConversationToolCall, ProposedTree } from '../lib/conversations.js';
import { historyForPrompt, needsHandoff, trimKoalaThread, withHandoff } from '../lib/koala-context.js';
import { buildKoalaPrompt } from '../lib/koala-persona.js';
import { runKoalaTool } from '../lib/koala-tool-runner.js';
import { KOALA_TOOLS } from '../lib/koala-tools.js';
import { ToolCallScanner } from '../lib/leaf-tools.js';
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

    const now = new Date().toISOString();
    const tree: Tree = {
      ...normaliseTreeInput({ name: proposal.name, type: proposal.type, goal: proposal.goal }),
      id: uuidv4(),
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    } as Tree;
    await db.saveTree(tree);
    await db.saveConversation({
      ...conversation,
      proposedTrees: (conversation.proposedTrees ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, treeId: tree.id } : p)),
      updatedAt: now,
    });
    res.json({ tree });
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

  /**
   * One general-chat turn.
   *
   * ── WHY THE TOOL ROUNDS ARE NOT STREAMED ──
   * Only the final answer is. A tool round produces no prose worth watching arrive — it produces a
   * function call — and streaming it means reassembling tool_calls from deltas, which is the fiddly
   * part of the branch route. The visible result is the same and the failure modes are far fewer.
   */
  router.post('/chat', async (req, res) => {
    const userId = (req as any).user.id;
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
    {
      const enabledNow = enabledForSession(conversation, sessionId);
      const promptNow = JSON.stringify([
        { role: 'system', content: buildKoalaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', servers, enabledNow) },
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

    /**
     * Sliced at the last handoff, so a reset thread does not silently keep paying for the messages
     * it just summarised. With no handoff this is the whole conversation, unchanged.
     */
    const conversationFor = (list: string[]) => [
      { role: 'system', content: buildKoalaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', servers, list) },
      ...historyForPrompt(conversation!.messages).map((m) => ({ role: m.role, content: m.content })),
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
      const turn: any[] = conversationFor(enabled);
      const enabledNow: string[] = [];
      const proposed: ProposedTree[] = [];

      /**
       * Streamed from the first round, not just the last.
       *
       * The rounds used to be non-streamed on the reasoning that a tool round produces no prose
       * worth watching. That was wrong twice over: a reasoning model produces a great deal of
       * thinking per round, and a turn that spends eighty seconds deciding what to do showed
       * "Koala is thinking…" the whole time with nothing behind it. Branch chat has always shown
       * its deliberation, and this is the same model doing the same kind of work.
       */
      /**
       * `openSse` rather than three hand-written headers — and this route was missing a fourth.
       *
       * It had no `X-Accel-Buffering: no`, which `/api/chat` sets with a comment explaining why:
       * nginx buffers proxied responses by default, so every frame arrives at once when the
       * response ends. Behind the platform's own proxy this stream was not streaming; it looked
       * like a model that thought for a long time and then answered instantly.
       */
      openSse(res);

      let answer = '';
      /**
       * Prose the model said on a round that ALSO called a tool.
       *
       * `answer` is only assigned on the round that stops, so "Let me check the logs first —"
       * streamed to the reader live and then vanished on reload: the persisted message was whatever
       * the final round said, or empty. The reader watched Koala say something and then found it
       * gone, which reads as the app losing their conversation.
       *
       * Kept as a fallback rather than concatenated: when the last round DID answer, that answer is
       * the reply and the running commentary before it is noise.
       */
      let spoken = '';
      /** Whether the last round still wanted tools when the round budget ran out. */
      let exhaustedRounds = false;
      /** What this turn did, for the transcript and for the handoff artifact. See ConversationMessage. */
      const toolCalls: ConversationToolCall[] = [];

      /**
       * Announced BEFORE the call, which is the whole point.
       *
       * `get_logs` shells out to kubectl and an MCP call crosses the network; both were rendering
       * as "Koala is thinking…" with nothing behind them. The pill appears while the work happens
       * and flips when the result lands.
       */
      const announceCall = (c: { id: string; name: string; arguments: string }) => {
        sendFrame(res, {
          toolCall: { id: c.id, name: c.name, args: (c.arguments || '').slice(0, MAX_TOOL_CALL_ARGS) },
        });
      };

      /**
       * The result, digested.
       *
       * Never the full payload: a remote result runs to MAX_REMOTE_RESULT and is not persisted, so
       * streaming it whole would make the live view and the reloaded view disagree about the same
       * turn. Both sides get the same clipped digest, so they agree by construction.
       */
      const recordResult = (c: { id: string; name: string; arguments: string }, result: string) => {
        const ok = !toolRefused(result);
        const digest = result.slice(0, MAX_TOOL_CALL_DIGEST);
        if (toolCalls.length < MAX_TOOL_CALLS_PER_MESSAGE) {
          toolCalls.push({
            id: c.id, name: c.name,
            args: (c.arguments || '').slice(0, MAX_TOOL_CALL_ARGS),
            ok, digest,
          });
        }
        sendFrame(res, { toolResult: { id: c.id, ok, digest } });
      };
      let thinking = '';

      const drain = async (upstream: Response) => {
        const scanner = new ToolCallScanner();
        let content = '';
        const reader = (upstream.body as any)?.getReader?.();
        if (!reader) return { calls: [], content };
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Tool calls arrive as fragments keyed by index — the scanner reassembles them, and
          // reading only the first delta would execute a call with empty arguments.
          scanner.push(chunk);
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const delta = JSON.parse(payload)?.choices?.[0]?.delta;
              // Two channels, forwarded separately so the UI can collapse one and show the other.
              if (delta?.reasoning_content) {
                thinking += delta.reasoning_content;
                sendFrame(res, { reasoning: delta.reasoning_content });
              }
              if (delta?.content) {
                content += delta.content;
                sendFrame(res, { delta: delta.content });
              }
            } catch { /* a partial frame; the next chunk completes it */ }
          }
        }
        return { calls: scanner.result(), content };
      };

      for (let round = 0; round < KOALA_TOOL_ROUNDS; round++) {
        /**
         * Trimmed per round, because ONE turn can outgrow the window on its own.
         *
         * `turn` grows by an assistant message plus a tool result every round, and a remote result
         * is allowed up to MAX_REMOTE_RESULT characters — twelve rounds of those is ~144KB against
         * a 32k-token window. The thread being short is no protection: a single question that makes
         * Koala read three sets of pod logs is enough.
         *
         * `trimConversation` is the leaf loop's, unchanged, because this is exactly the shape it
         * was written for: it blanks over-budget TOOL output rather than deleting it, since
         * removing a `tool` message orphans the `tool_calls` entry that referenced it and the API
         * rejects the request outright. PRESERVE_HEAD=2 pins the system prompt and the oldest
         * message, and it walks newest-first, so the rounds that the next decision depends on stay
         * intact. Reassigned into a local rather than mutating `turn`, so the untrimmed array is
         * still what gets appended to and what the next round trims from scratch.
         */
        exhaustedRounds = round === KOALA_TOOL_ROUNDS - 1;
        const sent = trimConversation(turn);

        /**
         * Refuse before the engine does, with something a reader can act on.
         *
         * `fittedMaxTokens` floors at MIN_TURN_TOKENS, so once the prompt exceeds the window it
         * stops reporting a smaller budget and just asks for 600 tokens on top of a prompt that
         * already does not fit. The engine allocates the pair up front and returns an opaque 400.
         * Nothing downstream recovers from that, and the reader sees a chat that stopped working.
         */
        if (fittedMaxTokens(KOALA_MAX_TOKENS, promptCharsFor(sent, enabled)) <= MIN_TURN_TOKENS) {
          sendFrame(res, {
            error: 'This conversation has outgrown the model\'s context window. Start a new one to keep going — '
              + 'the trees and specs you have already accepted are safe.',
          });
          break;
        }

        const step = await call(sent, true, enabled);
        if (!step.ok || !step.body) {
          sendFrame(res, { error: `Model returned ${step.status}` });
          break;
        }
        const { calls, content } = await drain(step as any);
        console.log(`[koala] round ${round}: calls=${calls.length} content=${content.length} thinking=${thinking.length}`);
        if (content.trim()) spoken = content;

        if (!calls.length) {
          /**
           * The round that stops IS the answer, and it has already been streamed to the reader.
           *
           * Asking again for a "final" reply cost an inference and returned nothing: measured, a
           * round produced 491 characters, was discarded, and the fresh call on an identical
           * conversation came back empty. The model had said its piece and would not repeat it.
           */
          answer = content;
          exhaustedRounds = false;
          break;
        }

        turn.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });

        for (const c of calls) {
          announceCall(c);
          /**
           * A tool belonging to an enabled service goes to that service.
           *
           * Missing this made the whole mechanism a loop: the model enabled `github-mcp`, was
           * offered `github-mcp__github-get-repo`, called it, and the runner — which only knows
           * Koala's own tools — answered "No tool named …". It retried until the budget died with
           * `finish_reason: length`. 351 seconds, no answer.
           *
           * `routeCall` refuses any name that is not `server__tool` for an ENABLED service, so
           * running it first cannot swallow Koala's own tools.
           */
          const route = routeCall(c.name, enabled);
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
            recordResult(c, trimmed);
            turn.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: trimmed });
            continue;
          }

          const out = await runKoalaTool(
            {
              db, userId, conversationId: conversation!.id, sessionId,
              servers, webSearch: executeWebSearch, fetchWebPage: executeFetchWebPage,
              /**
               * Read-only, and only ever the two diagnostic commands the runner builds — it takes
               * an argument array, never a string, so nothing a model writes reaches a shell.
               */
              kubectl: (a: string[]) => new InfrastructureService().runKubectl(a).then((r: any) =>
                typeof r === 'string' ? r : (r?.stdout ?? '')),
            },
            { name: c.name, arguments: c.arguments },
          );
          /**
           * A service enabled mid-turn widens the NEXT round's tools.
           *
           * Without this the model enables something and cannot call it until the user sends
           * another message, which makes the lazy mechanism a two-message ritual.
           */
          if (out.enabled && !enabled.includes(out.enabled)) {
            enabled = [...enabled, out.enabled];
            enabledNow.push(out.enabled);
            sendFrame(res, { enabled: [out.enabled] });
            // The system message carries the catalogue, so it is rewritten with the new state.
            turn[0] = { role: 'system', content: buildKoalaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', servers, enabled) };
          }
          if (out.proposed) {
            proposed.push(out.proposed);
            sendFrame(res, { proposedTree: out.proposed });
          }
          if (out.proposedSpec) {
            sendFrame(res, { proposedSpec: out.proposedSpec });
          }
          recordResult(c, out.content);
          turn.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: out.content });
        }
      }

      /**
       * ── ONE LAST ROUND, WITH THE TOOLS TAKEN AWAY ──
       *
       * Twelve rounds that all called tools leaves `answer` empty, and the turn persisted a blank
       * assistant message: the reader watched Koala work for a minute and got an empty bubble.
       *
       * This does NOT contradict the decision recorded above about not asking for a "final" reply.
       * That one is about a round which already produced content and then stopped — asking again
       * there was measured as an inference that returned nothing, because the model had said its
       * piece. This is the opposite case: a round that produced NO content and was still reaching
       * for tools. Different situation, different answer. Someone will want to unify these; the
       * distinguishing fact is whether the loop ended by choice or by running out.
       *
       * `tool_choice: 'none'` is what makes it a wrap-up rather than a thirteenth working round —
       * the model cannot decide to keep going, which is the whole reason the budget was reached.
       * The same shape as the agent loop's forced `finish` turn.
       */
      if (exhaustedRounds && !answer) {
        try {
          const last = await call(trimConversation(turn), true, enabled, { tool_choice: 'none' });
          if (last.ok && last.body) {
            const { content } = await drain(last as any);
            if (content.trim()) answer = content;
          }
        } catch (err: any) {
          // A wrap-up that fails must not take down the turn's own record — `spoken` and the tool
          // list below are still true, and still worth persisting.
          console.warn(`[koala] forced wrap-up failed: ${err.message}`);
        }
      }

      /**
       * Still nothing to show. Say so as a notice rather than persisting an empty bubble, which
       * reads as the app breaking rather than as the turn running long.
       */
      const ranDry = exhaustedRounds && !answer && !spoken;

      // Persisted after the stream, so a reader who disconnects mid-answer does not lose what the
      // model already said.
      const saved = (await db.getConversations()).find((c) => c.id === conversation!.id);
      if (saved) {
        await db.saveConversation({
          ...saved,
          messages: [...saved.messages, {
            role: 'assistant' as const,
            // `spoken` covers the turn that talked while working and then ran out of rounds —
            // without it that message persists empty and the UI shows a blank bubble.
            content: answer || spoken
              || `Koala used all ${KOALA_TOOL_ROUNDS} tool rounds without reaching an answer. `
                + 'Ask again and it will continue from what it found.',
            at: new Date().toISOString(),
            ...(thinking.trim() ? { reasoning: thinking.slice(-20000) } : {}),
            ...(enabledNow.length ? { enabled: enabledNow } : {}),
            ...(toolCalls.length ? { toolCalls } : {}),
            // A notice, not a boundary: this summarises nothing, so it must not truncate the next
            // prompt the way a handoff does. See ConversationMessage.handoff.
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
