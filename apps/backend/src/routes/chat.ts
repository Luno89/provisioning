import { Router, type Request } from 'express';
import { acceptLeaf } from '../lib/accept-leaf.js';
import { usableAcceptancePlan } from '../lib/acceptance.js';
import { wantsMcp } from '../lib/agent-run.js';
import { DEFAULT_POLICY, reviewBatch } from '../lib/auto-accept.js';
import type { AutoAcceptPolicy } from '../lib/auto-accept.js';
import { withNotice } from '../lib/branch-notice.js';
import { NO_CHAT_MCP, chatMcpFor } from '../lib/chat-mcp.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_TEMPLATE_VARS, buildExtractionPrompt, extractServiceName, parseExtractionResult } from '../lib/extraction.js';
import { buildOutboundMessages } from '../lib/leaf-context.js';
import { LEAF_TOOLS, MAX_TOOL_ROUNDS, ToolCallScanner } from '../lib/leaf-tools.js';
import type { ToolCall } from '../lib/leaf-tools.js';
import { deriveBranchTitle, trimTranscript } from '../lib/leaves.js';
import type { Branch, BranchMessage, Leaf } from '../lib/leaves.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { buildModelRequest } from '../lib/model-request.js';
import { MAX_ASSIGNMENT_ROUNDS, buildAssignmentPrompt, buildUnassignedNotice, unassignedLeaves } from '../lib/persona-assignment.js';
import { resolveConfig } from '../lib/personas.js';
import type { Persona } from '../lib/personas.js';
import { AMBIENT_PROPOSAL_PROMPT, MAX_PROPOSALS_PER_REPLY, PLAN_SYSTEM_PROMPT, extractProposals, isChatMode, parseChatCommand } from '../lib/plan-mode.js';
import type { ChatMode, LeafProposal } from '../lib/plan-mode.js';
import { planNotice, reviewPlan } from '../lib/plan-review.js';
import { duplicateNotice, newProposals, resolvePersonaNamed, suspectedDuplicates } from '../lib/proposal-merge.js';
import { TOOL_DISCIPLINE_PROMPT, fittedMaxTokens } from '../lib/sampling.js';
import { claimNotice, claimService } from '../lib/service-claim.js';
import { FinishReasonScanner, estimatePromptComplexity } from '../lib/smart-token-controller.js';
import { forwardChunk, sendFrame } from '../lib/sse.js';
import { ReasoningScanner, ThoughtFeatureExtractor, predictFailure, updateModelProfile } from '../lib/thinking-classifier.js';
import { ContentScanner, UsageScanner } from '../lib/token-usage.js';
import { resolveTreeType } from '../lib/tree-types.js';
import { withProject } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';
import type { ModelService } from '../services/ModelService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';

/**
 * The harness chat turn — the workbench's model conversation, with tools.
 *
 * ── MOVED VERBATIM, AND WHY THAT MATTERS MOST HERE ──
 * This route is a byte-for-byte SSE PASSTHROUGH: it forwards the upstream provider's own OpenAI
 * frames with `res.write(Buffer.from(value))` rather than decoding and re-encoding them, because
 * the frontend parses `choices[0].delta` straight off the provider's wire format. Re-serialising
 * would silently drop any field the re-encoder did not know about.
 *
 * It also aborts the upstream MID-STREAM when the thought monitor trips (`upstreamAbort.abort()`),
 * which is why it cannot be expressed as `runAgentLoop`: that loop requires a `sandbox` and its
 * only hook is `onStep` — per step, not per token. Putting this on it would break streaming. That
 * was checked rather than assumed.
 *
 * So: no logic changed in this move. `chat.test.ts` pins the frame sequence so the LATER
 * consolidation with `routes/koala.ts` (which speaks a different envelope on purpose) has a net.
 */

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface ChatRouterDeps {
  db: Database;
  modelService: ModelService;
  temporalBridge: TemporalBridge;
  projectRepoService: ProjectRepoService;
  ownedPersonas: (userId: string) => Promise<Persona[]>;
  ownedBranches: (userId: string) => Promise<Branch[]>;
  ownedLeaves: (userId: string) => Promise<Leaf[]>;
  ownedTrees: (userId: string) => Promise<Tree[]>;
  /** Runs one board tool for a leaf. Shared with the leaf executor, so it stays injected. */
  runLeafTool: (userId: string, branchId: string, call: { name: string; arguments: any }) => Promise<any>;
  toolRefused: (result: string) => boolean;
}

export function chatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const {
    db, modelService, temporalBridge, projectRepoService,
    ownedPersonas, ownedBranches, ownedLeaves, ownedTrees, runLeafTool, toolRefused,
  } = deps;

  /**
   * Runs the extraction model over a conversation and returns proposed leaves.
   *
   * Non-streaming, low temperature, schema-constrained: this is a narrow deterministic job, not a
   * conversation. Every failure returns an empty array — an extractor that is down, slow or
   * confused must never fail the chat it was called from, because the user already has their reply.
   */
  async function extractViaModel(
    extractor: { baseUrl: string; apiKey?: string; provider: { model: string; name: string } },
    turns: { role: string; content: string }[],
  ): Promise<LeafProposal[]> {
    const payloadBase = {
      ...(extractor.provider.model ? { model: extractor.provider.model } : {}),
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionPrompt(turns) },
      ],
      template_vars: EXTRACTION_TEMPLATE_VARS,
      temperature: 0.1,
      max_tokens: 800,
      stream: false,
    };

    // Try standard OpenAI / vLLM json_schema response_format first, then json_object, then legacy top-level json_schema
    const formats: Record<string, unknown>[] = [
      {
        ...payloadBase,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'leaf_proposals', schema: EXTRACTION_SCHEMA },
        },
      },
      {
        ...payloadBase,
        response_format: { type: 'json_object' },
      },
      {
        ...payloadBase,
        json_schema: EXTRACTION_SCHEMA,
      },
    ];

    for (const bodyPayload of formats) {
      try {
        const res = await fetch(`${extractor.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(extractor.apiKey ? { authorization: `Bearer ${extractor.apiKey}` } : {}),
          },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          continue; // Try next payload format fallback
        }

        const body = (await res.json()) as any;
        const text = String(body?.choices?.[0]?.message?.content ?? '');
        const proposals = parseExtractionResult(text, MAX_PROPOSALS_PER_REPLY);
        if (proposals.length > 0) return proposals;
        if (text.trim()) return proposals; // Valid response (even if 0 proposals)
      } catch (err: any) {
        console.warn(`[extract] attempt failed for ${extractor.provider.name}: ${err.message}`);
      }
    }

    return [];
  }

  /**
   * Streaming chat against one of the caller's own model endpoints.
   *
   * Proxied rather than called from the browser because the endpoint is only reachable through a
   * process-local kubectl port-forward — handing the browser that URL would neither work nor be
   * safe. The upstream body is passed through untouched: vLLM and TabbyAPI both speak the OpenAI
   * schema, and re-encoding it here would mean tracking every field either adds.
   */
  router.post('/', async (req, res) => {
    const { modelId, messages, stream = true, leafId, branchId, mode: rawMode, personaId, ...rest } = req.body ?? {};
    // Unknown or missing modes fall back to 'auto' rather than erroring: a chat request should
    // never fail because a selector was out of date.
    const mode: ChatMode = isChatMode(rawMode) ? rawMode : 'auto';
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    // There is no plan MODE. Proposing is always available, and an explicit /plan only escalates
    // it — stronger instructions and a bigger budget — so the user can force it when the model
    // would have declined. Parsed from the LAST message, which is the one being sent now.
    const lastIndex = messages.length - 1;
    const command = parseChatCommand(String(messages[lastIndex]?.content ?? ''));
    /**
     * What already exists on this branch, so the model is not blind to its own output.
     *
     * Without it the model proposes the same work every turn — from its point of view nothing was
     * ever created. Skipped in chat mode, where no leaves are in play and the tokens would be
     * spent describing work the user explicitly did not want discussed.
     */
    /**
     * This conversation's work, and the rest of the project's.
     *
     * The context used to stop at the branch, so a second conversation about the same project
     * started blind to everything the first one built — it could not see a single finished leaf and
     * had no way to avoid proposing the same work over again. Sibling branches are found through
     * the tree, so an unfiled conversation correctly has none.
     */
    const ownAll = await ownedLeaves((req as any).user.id);
    const branchLeaves = branchId ? ownAll.filter((l) => l.branchId === branchId) : [];

    let siblingLeaves: typeof ownAll = [];
    let siblingBranches: Awaited<ReturnType<typeof ownedBranches>> = [];
    if (branchId) {
      const all = await ownedBranches((req as any).user.id);
      const branch = all.find((b) => b.id === branchId);
      if (branch?.treeId) {
        siblingBranches = all.filter((b) => b.treeId === branch.treeId && b.id !== branchId);
        const siblingIds = new Set(siblingBranches.map((b) => b.id));
        siblingLeaves = ownAll.filter((l) => siblingIds.has(l.branchId));
      }
    }

    /**
     * What this turn actually runs under: built-in constants, then the adopted profile, then the
     * chosen persona, then whatever the client posted.
     *
     * The profile step is new. This route read no profile at all — measured, not assumed — so a
     * configuration promoted from an experiment applied to leaf runs and to the Lab while chat
     * quietly kept running the shipped values, and the promote dialog's "applies to leaf runs too"
     * read as "applies everywhere".
     */
    const chatPersona = personaId
      ? (await db.getPersonas()).find((p) => p.id === String(personaId) && p.ownerId === (req as any).user.id) ?? null
      : null;
    if (personaId && !chatPersona) {
      // Not silently ignored: a turn answered by nobody in particular, when a persona was asked
      // for, is the failure that looks like the model forgetting who it is.
      return res.status(404).json({ error: 'No such persona' });
    }
    const resolved = resolveConfig(
      await db.getHarnessProfile((req as any).user.id),
      chatPersona,
      rest,
    );

    // `/plan` overrides the mode for this turn; otherwise the mode decides.
    const planning = command.command === 'plan' || mode === 'plan';
    const explicitPlan = planning;
    const extracting = planning || mode === 'auto';
    const strategy = estimatePromptComplexity(messages, mode, explicitPlan);
    const offerTools = Boolean(branchId) && mode !== 'chat' && (explicitPlan || strategy.tier !== 'casual');
    /**
     * What this KIND of project means by finished.
     *
     * `TREE_TYPES` has carried a `doneMeans` for eleven types since trees were introduced and
     * nothing ever read one. `api-service` has said "its tests pass, it builds, it deploys, and the
     * endpoint responds" the whole time, while planners wrote whatever acceptance occurred to them —
     * which is how a run ended with `echo` as its only check.
     */
    const planTree = branchId
      ? await (async () => {
          const b = (await ownedBranches((req as any).user.id)).find((x) => x.id === branchId);
          return b?.treeId
            ? (await ownedTrees((req as any).user.id)).find((t) => t.id === b.treeId)
            : undefined;
        })()
      : undefined;
    // Resolved from the owner's records rather than a constant table — see lib/tree-types.ts.
    const doneMeans = planTree
      ? (await resolveTreeType(db, planTree.ownerId, planTree.type))?.doneMeans
      : undefined;

    const outboundMessages = buildOutboundMessages({
      ...(doneMeans ? { doneMeans } : {}),
      messages,
      lastIndex,
      prompt: explicitPlan ? PLAN_SYSTEM_PROMPT : extracting ? AMBIENT_PROPOSAL_PROMPT : undefined,
      leaves: branchLeaves,
      siblingLeaves,
      siblingBranches,
      // Only when tools are actually offered — otherwise it is instructions about a capability the
      // model does not have this turn.
      ...(offerTools ? { toolPrompt: TOOL_DISCIPLINE_PROMPT } : {}),
      ...(explicitPlan ? { planText: command.text } : {}),
      ...(resolved.systemPrompt ? { personaPrompt: resolved.systemPrompt } : {}),
    });

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl((req as any).user.id, modelId));
    } catch (err: any) {
      // A missing/unowned model is the caller's problem, not a server fault.
      return res.status(404).json({ error: err.message });
    }

    /**
     * One builder for every call this turn makes.
     *
     * Built-in sampling, then the resolved chain written through the registry so each knob lands
     * where the engine actually reads it. Four call sites used to assemble this inline and no two
     * agreed: three spread the raw request instead of the resolved chain, all four applied the
     * built-in defaults LAST (which silently undid the adopted profile), and the hand-rolled
     * filter sent `think` as a top-level field the engine ignores.
     */
    const turnRequest = (
      messages: unknown,
      opts: { tools?: unknown; stream: boolean; maxTokens: number; reasoningEffort?: string; extra?: Record<string, unknown> },
    ) => buildModelRequest({
      turn: 'conversation',
      ...(provider.kind ? { kind: provider.kind } : {}),
      messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      stream: opts.stream,
      maxTokens: opts.maxTokens,
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(provider.model ? { model: provider.model } : {}),
      overrides: resolved.overrides,
      ...(opts.extra ? { extra: opts.extra } : {}),
    }).body;


    // Abort the upstream request if the browser goes away mid-stream, or a closed tab leaves a
    // generation running on the GPU until it finishes.
    const upstreamAbort = new AbortController();
    res.on('close', () => upstreamAbort.abort());

    try {
      /**
     * What the persona you are TALKING TO may call.
     *
     * Resolved once per turn, not per round: the registry caches introspection but the listing is
     * still a database read plus a NodePort lookup per server, and a turn can take eight rounds.
     *
     * Soft in every direction — a registry that cannot be reached leaves chat exactly as it was
     * rather than failing a conversation over a service it may not even need.
     */
    let chatMcp = NO_CHAT_MCP;
    try {
      if (wantsMcp(chatPersona).length) {
        const reg = new McpRegistryService(db, (req as any).user.id, (n: string) => resolveMcpProbeUrl(n));
        chatMcp = chatMcpFor(chatPersona, await reg.listWithTools(), (srv, tool, a) => reg.call(srv, tool, a));
        if (chatMcp.missing.length) {
          console.warn(`[chat] persona named MCP servers that are not usable — ${chatMcp.missing.join(', ')}`);
        }
      }
    } catch (err: any) {
      console.warn(`[chat] could not resolve MCP tools for this turn: ${err.message}`);
    }
    /** The board tools plus whatever the persona was granted. One array, built once. */
    const turnTools = chatMcp.tools.length ? [...LEAF_TOOLS, ...chatMcp.tools] : LEAF_TOOLS;

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Only ever the caller's own stored key, decrypted per request — never logged, never
          // returned to the browser.
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        // Omit `model` entirely when unknown rather than falling back to the deployment NAME, which
        // is never a valid model id. TabbyAPI ignores the field (confirmed live: it serves
        // "turboderp-qwen3-6-27b-exl3-5-00bpw" regardless of what is sent, having derived its own
        // id from the repo and bitrate), but a stricter server would reject "Tabbyapi-Production"
        // outright — and single-model endpoints generally serve whatever they loaded.
        body: JSON.stringify(turnRequest(outboundMessages, {
          // Offered only when in proposal/plan mode on a task-relevant turn. Selective tool framing
          // prevents casual Q&A turns from degenerating into tool-schema deliberation loops.
          ...(offerTools ? { tools: turnTools } : {}),
          stream,
          /**
           * Fitted to what the window has left, not asked for flat.
           *
           * The engine allocates prompt + max_tokens up front and refuses the job if the pair does
           * not fit — `Job requires 136 pages (only 128 available)`, which is 34,816 against a
           * 32,768 window. The agent loop was fixed for exactly this and the chat route never was,
           * so a plan turn with a long system prompt was refused before generating a single token.
           */
          maxTokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
          reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
          extra: {
            max_completion_tokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            // Streaming responses omit usage unless asked, and then only in the final chunk.
            ...(stream ? { stream_options: { include_usage: true } } : {}),
          },
        })),
        signal: upstreamAbort.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        // Surface the engine's own message — vLLM's errors (bad sampling params, context length
        // exceeded) are specific and actionable, and replacing them with a generic 502 throws away
        // the only useful information.
        return res.status(upstream.status).json({ error: detail || `Model returned HTTP ${upstream.status}` });
      }

      res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      // Without this, a proxy in front of the backend may buffer the whole stream and defeat the
      // point of streaming at all.
      res.setHeader('X-Accel-Buffering', 'no');

      const targetModelId = provider.model ?? modelId ?? 'default-model';
      const globalProfile = await db.getModelThinkingProfile?.(targetModelId).catch(() => null) ?? undefined;
      const lastUserMsg = messages[messages.length - 1]?.content ?? '';
      const featureExtractor = new ThoughtFeatureExtractor(lastUserMsg);

      // Usage is watched as the stream passes through rather than read off a response body —
      // see lib/token-usage.ts. The client gets every byte unchanged; this only observes.
      const scanner = new UsageScanner();
      // Accumulated for every branch-scoped reply now, not just extracting ones: the transcript is
      // persisted server-side, so it must be captured even in chat mode. String accumulation is
      // cheap next to the inference that produced it.
      const content = branchId ? new ContentScanner() : undefined;
      const finishScanner = new FinishReasonScanner();
      const reasoningScanner = new ReasoningScanner();
      const decoder = new TextDecoder();
      let wasInterrupted = false;

      /**
       * Stream a response through to the client, watching for tool calls.
       *
       * Tool frames carry no content, so they are NOT forwarded — the client would render empty
       * assistant turns. Everything else passes through byte for byte.
       */
      const pump = async (body: ReadableStream<Uint8Array>): Promise<ToolCall[]> => {
        const tools = new ToolCallScanner();
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          scanner.push(text);
          content?.push(text);
          tools.push(text);
          finishScanner.push(text);
          const addedReasoning = reasoningScanner.push(text);
          if (addedReasoning) {
            featureExtractor.pushReasoning(addedReasoning);
          }

          const features = featureExtractor.extract();
          const sensitivity = (rest.thoughtMonitorSensitivity as any) ?? 'medium';
          const threshold = rest.failurePredictionThreshold !== undefined ? Number(rest.failurePredictionThreshold) : 0.85;
          const repeatCap = rest.ngramRepeatThreshold !== undefined ? Number(rest.ngramRepeatThreshold) : 5;
          const pred = predictFailure(features, globalProfile, sensitivity, threshold, repeatCap);
          if (pred.shouldInterrupt && !wasInterrupted) {
            wasInterrupted = true;
            const reasonMsg = pred.reason ?? 'Overthinking loop detected';
            sendFrame(res, { interruptedReason: reasonMsg });
            upstreamAbort.abort();
            break;
          }

          forwardChunk(res, value);
        }
        return tools.result();
      };

      let calls = await pump(upstream.body);

      /**
       * Tool loop. Each round is a full inference pass, so it is capped — a model that keeps
       * calling tools without answering is a loop, not a thorough one.
       */
      const conversation: any[] = [...outboundMessages];

      /**
       * Whether this turn created leaves through the TOOLS.
       *
       * Tracked here rather than read off `calls`, which the loop below overwrites with each
       * round's result and which is empty by the time anyone would ask.
       */
      let proposedViaTools = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS && calls.length > 0 && branchId; round++) {
        conversation.push({
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of calls) {
          /**
           * A qualified remote name goes to its server; everything else is a board tool.
           *
           * `routeCall` refuses any name that is not `server__tool` for a granted server, so this
           * cannot swallow `propose_leaf` — and checking it FIRST is safe only because of that
           * refusal. The executor's loop had the same ordering bug caught by a test: trying remote
           * before built-in let a handler shadow `run_command`.
           */
          const remote = await chatMcp.call(call.name, JSON.parse(call.arguments || '{}'));
          if (remote) {
            conversation.push({
              role: 'tool', tool_call_id: call.id, name: call.name,
              content: JSON.stringify({ ...(remote.isError ? { error: remote.text } : { result: remote.text }) }),
            });
            continue;
          }
          const result = await runLeafTool((req as any).user.id, String(branchId), call);
          // A refused call created nothing, so it must not suppress extraction — that would turn a
          // rejected proposal into a turn that proposed nothing at all.
          if (call.name === 'propose_leaf' && !toolRefused(result)) proposedViaTools = true;
          conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
        }

        const followUp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(turnRequest(conversation, {
            tools: turnTools,
            stream: true,
            /**
           * Fitted to what the window has left, not asked for flat.
           *
           * The engine allocates prompt + max_tokens up front and refuses the job if the pair does
           * not fit — `Job requires 136 pages (only 128 available)`, which is 34,816 against a
           * 32,768 window. The agent loop was fixed for exactly this and the chat route never was,
           * so a plan turn with a long system prompt was refused before generating a single token.
           */
          maxTokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: {
              max_completion_tokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
              stream_options: { include_usage: true },
            },
          })),
          signal: upstreamAbort.signal,
        });
        if (!followUp.ok || !followUp.body) break;
        calls = await pump(followUp.body);
      }

      /**
       * Every proposed leaf must have somebody to do it.
       *
       * A persona carries the whole environment now — image, network, tools, budget, where the
       * output goes — so a leaf without one does not run with defaults, it runs as nobody. The
       * planner is the thing that decides who does what, and this is what holds it to that: it is
       * asked again, with the leaves named and the personas listed, because the usual cause is a
       * model that did not have the names to hand.
       *
       * Bounded, and then handed over. Refusing the leaves would throw away a decomposition that is
       * probably correct over a field the model forgot; choosing for it would be exactly the guess
       * this design removed.
       */
      /**
       * Settle whatever this turn proposed: assign personas, then start what is routine.
       *
       * Called from BOTH paths that create leaves. It used to be inline and gated on
       * `proposedViaTools`, so a plan the model wrote as PROSE — turned into leaves by the
       * ambient extractor further down — got neither. Measured on a real end-to-end run: zero
       * propose_leaf calls, two leaves created by extraction, one of them with no persona, and
       * nothing started. The leaf with no persona could not even be accepted afterwards,
       * because a leaf with no persona has no repository and its work would be discarded.
       */
      const settleProposals = async () => {
        if (!branchId) return;
        for (let round = 0; round < MAX_ASSIGNMENT_ROUNDS; round++) {
          const missing = unassignedLeaves(await db.getLeaves(), String(branchId));
          if (!missing.length) break;

          const mine = (await db.getPersonas()).filter((p) => p.ownerId === (req as any).user.id);
          if (!mine.length) break; // Nothing to choose from; the notice below says so instead.

          conversation.push({ role: 'user', content: buildAssignmentPrompt(missing, mine) });
          const retry = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(turnRequest(conversation, {
              tools: LEAF_TOOLS,
              stream: false,
              maxTokens: strategy.maxTokens,
            })),
            signal: upstreamAbort.signal,
          }).catch(() => undefined);
          if (!retry?.ok) break;

          const body: any = await retry.json().catch(() => undefined);
          const retryCalls = body?.choices?.[0]?.message?.tool_calls ?? [];
          if (!retryCalls.length) break;

          conversation.push({ role: 'assistant', content: null, tool_calls: retryCalls });
          for (const c of retryCalls) {
            const out = await runLeafTool((req as any).user.id, String(branchId), { name: c.function.name, arguments: c.function.arguments });
            conversation.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: out });
          }
        }

        /**
         * Whatever the planner still would not assign goes to the user.
         *
         * Written to the branch as a notice rather than logged, because the person who has to
         * decide is the one reading the conversation — a warning in a server log is a warning
         * nobody receives.
         */
        const stillMissing = unassignedLeaves(await db.getLeaves(), String(branchId));
        if (stillMissing.length) {
          const latest = (await db.getBranches()).find((b: Branch) => b.id === branchId);
          if (latest) await db.saveBranch(withNotice(latest, buildUnassignedNotice(stillMissing)));
          console.warn(`[chat] ${stillMissing.length} leaf(s) on branch ${String(branchId).slice(0, 8)} have no persona`);
        }

        const all = (await ownedLeaves((req as any).user.id)).filter((l) => l.branchId === branchId);
        const branch = (await db.getBranches()).find((b: Branch) => b.id === branchId);
        const policy: AutoAcceptPolicy = {
          ...DEFAULT_POLICY,
          // The branch's setting, unless this request said otherwise. Off unless switched on:
          // accepting work spends a budget and runs commands in a sandbox.
          enabled: typeof rest.autoAccept === 'boolean' ? rest.autoAccept : branch?.autoAccept === true,
        };
        const reviewed = reviewBatch(all.filter((l) => l.status === 'proposed'), all, policy);

        const started: string[] = [];
        const held: string[] = [];
        for (const { leaf, verdict } of reviewed) {
          if (!verdict.accept) {
            if (policy.enabled) held.push(`${leaf.title} — ${verdict.reason}`);
            continue;
          }
          const outcome = await acceptLeaf(
            {
              db,
              startLeaf: (l) => temporalBridge!.startLeaf(l),
              signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
            },
            leaf,
            // Re-read, because accepting one leaf changes what blocks the next.
            (await ownedLeaves((req as any).user.id)).filter((l) => l.branchId === branchId),
          );
          if (outcome.ok) started.push(leaf.title);
          else held.push(`${leaf.title} — ${outcome.error}`);
        }

        if (started.length || held.length) {
          const latest = (await db.getBranches()).find((b: Branch) => b.id === branchId);
          if (latest) {
            await db.saveBranch(withNotice(latest, {
              text: [
                started.length ? `Started automatically: ${started.join(', ')}.` : '',
                held.length ? `Waiting for you: ${held.join('; ')}.` : '',
              ].filter(Boolean).join(' '),
            }));
          }
          console.log(`[chat] auto-accept started ${started.length}, held ${held.length}`);
        }
      };

      await settleProposals();

      /**
       * Start the proposals that are routine, once the personas are settled.
       *
       * Deliberately AFTER the assignment retry above: the policy refuses a leaf with no persona,
       * so running this first would hold every leaf the retry was about to fix.
       *
       * What is held is written into the transcript with its reason. A proposal that silently did
       * not start is indistinguishable from one the planner never made — which is the failure this
       * whole feature exists to fix, and it would be perverse to reintroduce it here.
       */

      /**
       * Out of tool rounds and still asking for more — so make it answer.
       *
       * Measured on a real conversation: four rounds, every one `finish_reason: tool_calls`, every
       * one zero characters of content. web_search returned five hits, fetch_web_page returned
       * pages whose stripped HTML held no usable figure, and the model simply searched again. The
       * loop then exited with a call still pending and the response ended having streamed NOTHING.
       * From the outside that is a chat that stops mid-thought for no stated reason.
       *
       * The final pass offers no tools at all, which is what makes it terminal — a nudge with the
       * tools still attached is just a fifth round. It says plainly that the budget is spent, so
       * the model reports what it found and what it could not confirm rather than inventing the
       * part it never reached.
       */
      if (calls.length > 0 && branchId) {
        sendFrame(res, { interruptedReason: `Used all ${MAX_TOOL_ROUNDS} research steps — answering with what was found.` });
        /**
         * Say WHICH calls were dropped, not just that the budget ran out.
         *
         * The calls in `calls` at this point were never executed, and the model does not know that
         * — it wrote them and moved on. Observed: a turn ended having reported that it attached a
         * project and set the acceptance plan, and neither call had run. Naming them is the
         * difference between the model correcting itself next turn and confidently claiming work
         * that never happened.
         */
        const dropped = [...new Set(calls.map((c) => c.name))].join(', ');
        conversation.push({
          role: 'user',
          content:
            'You have used all available research steps. These calls were NOT executed and did not '
            + `happen: ${dropped}. Answer now with what you found, say plainly that those were not `
            + 'done, and do not claim otherwise.',
        });
        const finalPass = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(turnRequest(conversation, {
            stream: true,
            /**
           * Fitted to what the window has left, not asked for flat.
           *
           * The engine allocates prompt + max_tokens up front and refuses the job if the pair does
           * not fit — `Job requires 136 pages (only 128 available)`, which is 34,816 against a
           * 32,768 window. The agent loop was fixed for exactly this and the chat route never was,
           * so a plan turn with a long system prompt was refused before generating a single token.
           */
          maxTokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: { stream_options: { include_usage: true } },
          })),
          signal: upstreamAbort.signal,
        });
        if (finalPass.ok && finalPass.body) await pump(finalPass.body);
      }

      // Automatic Continuation Pass: if the response ran out of tokens mid-thought (finish_reason === 'length'),
      // automatically send a seamless continuation pass so the model finishes its answer completely.
      if (finishScanner.result() === 'length' && calls.length === 0) {
        sendFrame(res, { interruptedReason: 'Completion token cap reached (finish_reason: length) — auto-continuing...' });
        const partialAnswer = content?.result() ?? '';
        const continuationMessages: any[] = [
          ...outboundMessages,
          { role: 'assistant', content: partialAnswer },
          { role: 'user', content: 'Continue your response from exactly where you left off.' },
        ];
        const continuationPass = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(turnRequest(continuationMessages, {
            stream: true,
            maxTokens: strategy.maxTokens,
            reasoningEffort: strategy.reasoningEffort,
            extra: {
              max_completion_tokens: strategy.maxTokens,
              stream_options: { include_usage: true },
            },
          })),
          signal: upstreamAbort.signal,
        });
        if (continuationPass.ok && continuationPass.body) {
          await pump(continuationPass.body);
        }
      }

      // Two-Stage Reasoning Architecture: If the model spent its generation on an inner monologue
      // without outputting final response prose, automatically trigger Stage 2 to stream the answer.
      const proseResult = (content?.result() ?? '').trim();
      if (!wasInterrupted && calls.length === 0 && !proseResult) {
        const monologueText = reasoningScanner.result() || featureExtractor.getText();
        if (monologueText && monologueText.length > 20) {
          const stage2Messages: any[] = [
            ...outboundMessages,
            { role: 'assistant', content: monologueText },
            { role: 'user', content: 'Based on your thoughts above, now state your concise final answer directly to the user.' },
          ];
          const stage2Pass = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(turnRequest(stage2Messages, {
              stream: true,
              maxTokens: strategy.maxTokens,
              reasoningEffort: strategy.reasoningEffort,
              extra: {
                max_completion_tokens: strategy.maxTokens,
                stream_options: { include_usage: true },
              },
            })),
            signal: upstreamAbort.signal,
          });
          if (stage2Pass.ok && stage2Pass.body) {
            await pump(stage2Pass.body);
          }
        }
      }

      res.end();

      // Update system-wide model thinking profile in MongoDB based on turn outcome
      try {
        const finalFeatures = featureExtractor.extract();
        const outcome = wasInterrupted ? 'failure' : 'success';
        const updatedProfile = updateModelProfile(globalProfile, targetModelId, finalFeatures, outcome);
        await db.saveModelThinkingProfile?.(updatedProfile);
      } catch {
        // Non-fatal training profile save error
      }

      // Proposals are created after the stream closes, from the assistant's CONTENT only —
      // never its reasoning, which routinely contains draft JSON the model then discarded.
      if (content && branchId) {
        try {
          const reply = content.result();

          /**
           * Persist the turn.
           *
           * Server-side rather than a client PATCH: a closed tab or a crashed browser would
           * otherwise lose the exchange that was just paid for. The branch is created on demand so
           * a conversation does not need to be declared before it starts.
           */
          try {
            const existing = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === (req as any).user.id);
            const userText = String(messages[lastIndex]?.content ?? '');
            const now = new Date().toISOString();
            const cleanReply = reply.includes('<think>')
              ? reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim() || reply
              : reply;
            /**
             * Reasoning is persisted alongside the reply.
             *
             * `BranchMessage.reasoning` has existed since branches did — "kept separately so it can
             * be collapsed, and dropped first when trimming" — and nothing ever wrote it. So the
             * deliberation was visible while the tab was open and gone the moment you navigated
             * away, because the only copy lived in the browser.
             *
             * Stored second to `content` and trimmed first, which is what the field was designed
             * for: it is the part you can afford to lose.
             */
            const thinking = reasoningScanner.result().trim();
            const turns: BranchMessage[] = [
              { role: 'user', content: userText },
              { role: 'assistant', content: cleanReply, ...(thinking ? { reasoning: thinking } : {}) },
            ];
            /**
             * Spread `existing` rather than naming the fields.
             *
             * `db.saveBranch` is a full replace, so every field not listed here was being DELETED
             * on every turn. That silently ate `acceptance` — the model called `set_acceptance`
             * during the turn, the tool wrote it, and this save immediately overwrote the branch
             * without it. Verified live: the sibling `set_leaf_project` call in the same turn stuck,
             * because it writes a LEAF.
             *
             * Fourth time this shape of bug has appeared here (saveDeploymentInfo's allowlist,
             * `dependsOn`, `expects`, and now this), which is why the fields below are the ones this
             * block genuinely owns and everything else rides on the spread.
             */
            await db.saveBranch({
              ...existing,
              id: String(branchId),
              ownerId: (req as any).user.id,
              // Named from the first message only — renaming is explicit, and re-deriving on every
              // turn would rewrite a title the user had chosen.
              title: existing?.title ?? deriveBranchTitle(userText),
              messages: trimTranscript([...(existing?.messages ?? []), ...turns]),
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            });
          } catch (err: any) {
            // Losing the transcript must not fail a reply the user already received.
            console.warn(`[chat] could not persist transcript for branch ${branchId}: ${err.message}`);
          }

          /**
           * Extraction path. The conversation model reasons — which is what makes it good to talk
           * to and unreliable at emitting a format (measured at roughly one success in eight) — so
           * the structured job goes to a small non-reasoning model with a schema.
           *
           * Only for an explicit /plan for now: it is a second inference call, and running it on
           * every reply needs latency measured rather than assumed.
           */
          let extracted: Awaited<ReturnType<typeof extractViaModel>> | undefined;
          if (extracting && !proposedViaTools) {
            // Falls back to the CONVERSATION model, which is safe now that extraction disables
            // thinking per-request. The earlier refusal to fall back was because a reasoning model
            // cannot hold a format — with thinking off it can, measured at 3/3 against 1-in-8.
            // A separately configured extractor still wins, for a model that cannot disable it.
            const extractor =
              (await modelService.resolveExtractor((req as any).user.id).catch(() => undefined)) ??
              { provider, baseUrl, ...(apiKey ? { apiKey } : {}) };
            extracted = await extractViaModel(extractor, [...messages.slice(0, lastIndex), { role: 'assistant', content: reply }]);
          }
          // Distinguish "nothing worth proposing" from "the model never got to answer". The
          // second is a real failure that otherwise looks identical to the first.
          // Only worth flagging for an explicit /plan: an ordinary reply legitimately has no
          // content only when something went wrong, but that is the streaming path's concern.
          if (explicitPlan && !reply.trim()) {
            console.warn(`[chat] /plan produced no content for branch ${branchId} — the reply was likely consumed by reasoning before reaching an answer; raise max_tokens`);
          }
          // Extractor first when it produced anything; otherwise fall back to parsing the
          // conversation model's own reply, which works occasionally and beats nothing.
          /**
           * Nothing to extract once the tools have run.
           *
           * These are two paths to the same outcome and they were both live on every `auto` turn
           * with a branch: the model called `propose_leaf`, then its own prose summary — "I've
           * proposed 5 leaves. Here is the plan: 1. … 2. …" — was parsed into five MORE. Measured
           * live: ten leaves on one branch, the same five titles twice, and a second approval
           * prompt for work that was already running.
           *
           * The tools win because they are the deliberate path: a model that called them has said
           * exactly what it wants, while the prose is a report of having done so.
           */
          /**
           * Prose proposals the tools did NOT already cover.
           *
           * These two paths were treated as exclusive: any `propose_leaf` call discarded the whole
           * prose block, on the reasoning that prose is a REPORT of what the tools did. That holds
           * when the model uses one path. It does not when it mixes them.
           *
           * Measured: a planning turn called propose_leaf twice, wrote FOUR leaves in its json
           * block, and produced one leaf. Three stages of a four-stage plan were silently dropped,
           * and nothing anywhere said so.
           *
           * Matched on title rather than trusting either path: a prose entry describing a leaf the
           * tools already made is a duplicate and must not be created twice, while one naming work
           * no tool call covered is a stage that would otherwise be lost.
           */
          const fromProse = extracted?.length ? extracted : extractProposals(reply);
          // This user's leaves, not every leaf on the instance: another tenant's title has no
          // business suppressing a proposal here, and getLeaves() is unscoped.
          const already = (await ownedLeaves((req as any).user.id))
            .filter((l) => l.branchId === String(branchId))
            .map((l) => l.title);
          const proposals = proposedViaTools ? newProposals(fromProse, already) : newProposals(fromProse, []);
          if (proposedViaTools && proposals.length) {
            console.log(`[chat] branch ${branchId}: ${proposals.length} prose proposal(s) the tool calls did not cover`);
          }
          const now = new Date().toISOString();

          /**
           * The name the planner chose for the service this work produces.
           *
           * Saved on the TREE rather than a leaf: it outlives any one conversation and is what
           * every tool the service exposes gets prefixed with. Without it the name falls back to
           * the tree's own, which is a heading rather than a prefix — "GitHub API MCP" becomes
           * `github-api-mcp__` where the planner asked for `gh__`.
           *
           * Only when the planner actually said something usable, and never overwriting a name
           * already set: renaming a live service would change every tool name under it.
           */
          const declaredName = extractServiceName(reply);
          if (declaredName && branchId) {
            const branchRecord = (await ownedBranches((req as any).user.id)).find((b) => b.id === branchId);
            const tree = branchRecord?.treeId
              ? (await ownedTrees((req as any).user.id)).find((t) => t.id === branchRecord.treeId)
              : undefined;
            if (tree && !tree.serviceName) {
              /**
               * A name someone else already owns means this is the SAME service.
               *
               * `serviceName` is what a service's tools are prefixed with and what a persona names
               * to reach it, so two trees declaring one name are two conversations about one
               * service. Observed: a second run correctly found `github-mcp` running, said "no need
               * to rebuild it", and still built in a new repository — because knowing a project id
               * in prose is not attaching it, and the model never called `set_leaf_project`. That
               * produced a second deployment under the same name, which then had to be worked
               * around in three separate readers.
               *
               * Adopting rather than refusing: "that name is taken" would make the user rename it
               * to `github-mcp-2`, which is the collision with extra steps.
               */
              const claim = claimService(declaredName, tree, await ownedTrees((req as any).user.id));
              const adopted = claim.adoptProjectId
                ? withProject({ ...tree, serviceName: declaredName, updatedAt: now }, claim.adoptProjectId)
                : { ...tree, serviceName: declaredName, updatedAt: now };
              await db.saveTree(adopted);
              console.log(
                `[chat] tree ${tree.id}: service named "${declaredName}" by the planner`
                + (claim.adoptProjectId ? ` — adopting the repository of "${claim.ownedBy?.treeName}"` : ''),
              );
              // Said out loud: a silent repoint is how the work ends up somewhere nobody expected.
              const text = claimNotice(declaredName, claim);
              if (text) {
                const fresh = (await db.getBranches()).find((b) => b.id === String(branchId));
                if (fresh) await db.saveBranch(withNotice(fresh, { text }));
              }
            }
          }
          /**
           * Resolved once for the batch, against this user's own personas.
           *
           * A name the model invented resolves to nobody and the leaf is created unassigned — the
           * same outcome as before this field existed, and still recoverable. Refusing the leaf
           * over a spelling mistake would trade real work for a typo.
           */
          const myPersonas = await ownedPersonas((req as any).user.id);
          const myProjects = await projectRepoService.listForOwner((req as any).user.id);
          for (const proposal of proposals) {
            const assigned = resolvePersonaNamed(proposal.persona, myPersonas);
            if (proposal.persona && !assigned) {
              console.warn(`[chat] branch ${branchId}: no persona named "${proposal.persona}" for "${proposal.title}"`);
            }
            await db.saveLeaf({
              id: uuidv4(),
              ownerId: (req as any).user.id,
              branchId: String(branchId),
              title: proposal.title,
              ...(proposal.body ? { body: proposal.body } : {}),
              ...(assigned ? { personaId: assigned.id } : {}),
              // Without this the leaf has no tools for the service the plan told it to call.
              ...(proposal.mcp?.length ? { mcp: proposal.mcp } : {}),
              // Owner-checked: a project id names a repository, and this arrives from model output.
              ...(proposal.projectId && myProjects.some((p) => p.id === proposal.projectId)
                ? { projectId: proposal.projectId }
                : {}),
              column: 'todo',
              // Proposed, always: the model suggests, a human accepts. Nothing runs or spends here.
              status: 'proposed',
              depth: 0,
              blocking: true,
              createdAt: now,
              updatedAt: now,
            });
          }
          /**
           * Read the plan back before anyone commits to it.
           *
           * The two plan-shaped things a person had to point out during a real end-to-end run —
           * five leaves with no ordering, and a dependency on a leaf that had been withdrawn — are
           * both mechanically detectable, and neither is something a user would know to look for.
           * Posted as a notice so it sits in the conversation next to the proposals it is about.
           *
           * Only when this turn actually proposed something: re-stating the same warnings on every
           * later turn is how a warning becomes wallpaper.
           */
          if (proposedViaTools || proposals.length) {
            const onBranch = (await ownedLeaves((req as any).user.id))
              .filter((l) => l.branchId === String(branchId));
            const declared = (await db.getBranches()).find((b) => b.id === String(branchId))?.acceptance;
            /**
             * Two leaves that look like one job get REPORTED, never dropped.
             *
             * Lexical similarity ranks the real observed duplicate below two leaves that must both
             * exist (lib/proposal-merge.ts has the numbers), so acting on it would delete stages of
             * real plans. The reviewer already accepts every leaf by hand and already caught this
             * one unaided — the notice puts the pair in front of them instead of guessing.
             */
            const warnings = [
              planNotice(reviewPlan(onBranch, usableAcceptancePlan(declared).length)),
              duplicateNotice(suspectedDuplicates(onBranch.map((l) => l.title))),
            ].filter(Boolean).join('\n\n');
            if (warnings) {
              const fresh = (await db.getBranches()).find((b) => b.id === String(branchId));
              if (fresh) await db.saveBranch(withNotice(fresh, { text: warnings }));
            }
          }

          /**
           * Extracted proposals get the same treatment as proposed ones.
           *
           * They are leaves either way. Only the tool path settled them before, so a plan the model
           * wrote as prose produced leaves that nothing assigned a persona to and nothing started —
           * and which then could not be accepted at all, since a leaf with no persona has no
           * repository. Measured on a real run: two extracted leaves, one unassigned, both stuck.
           */
          if (proposals.length) await settleProposals();
        } catch (err: any) {
          // A parsing failure must never fail a reply the user already received.
          console.warn(`[chat] could not record proposals for branch ${branchId}: ${err.message}`);
        }
      }

      // Recorded after the response is closed: metering must never delay the user's tokens, and a
      // failure to record must never fail a generation that already succeeded.
      const used = scanner.result();
      if (used && leafId) {
        try {
          const leaf = (await db.getLeaves()).find((c) => c.id === leafId && c.ownerId === (req as any).user.id);
          if (leaf) {
            await db.saveLeaf({
              ...leaf,
              usage: { ...leaf.usage, tokens: (leaf.usage?.tokens ?? 0) + used.totalTokens },
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (err: any) {
          console.warn(`[chat] could not record ${used.totalTokens} tokens against leaf ${leafId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      if (upstreamAbort.signal.aborted) return; // client hung up; nothing to report
      if (!res.headersSent) return res.status(502).json({ error: err.message });
      res.end();
    }
  });
  return router;
}
