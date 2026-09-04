import { Router, type Request } from 'express';
import { acceptLeaf } from '../lib/accept-leaf.js';
import { ToolService } from '../services/ToolService.js';
import { schemasFor } from '../lib/tool-catalogue.js';
import { usableAcceptancePlan } from '../lib/acceptance.js';
import { trimConversation, conversationBudget } from '../lib/sandbox-tools.js';
import { wantsMcp } from '../lib/agent-run.js';
import { DEFAULT_POLICY, reviewBatch } from '../lib/auto-accept.js';
import type { AutoAcceptPolicy } from '../lib/auto-accept.js';
import { withNotice } from '../lib/branch-notice.js';
import { runChatTurn } from '../lib/chat-runtime.js';
import { makePackToolExecutor } from '../lib/chat-pack-tools.js';
import type { StreamEvent, PostPass } from '../lib/round-loop.js';
import { toLoopTools } from '../lib/mcp-tools.js';
import { EXTRACTION_SCHEMA, EXTRACTION_TEMPLATE_VARS, buildExtractionPrompt, extractServiceName, parseExtractionResult } from '../lib/extraction.js';
import { buildOutboundMessages } from '../lib/leaf-context.js';
import { deriveBranchTitle, trimTranscript } from '../lib/leaves.js';
import type { Branch, BranchMessage, Leaf } from '../lib/leaves.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { buildModelRequest } from '../lib/model-request.js';
import { MAX_ASSIGNMENT_ROUNDS, buildAssignmentPrompt, buildUnassignedNotice, unassignedLeaves } from '../lib/persona-assignment.js';
import { resolvePrompt } from '../lib/personas.js';
import type { Persona } from '../lib/personas.js';
import { extractProposals, isChatMode, parseChatCommand } from '../lib/plan-mode.js';
import { packForRole } from '../lib/tree-type-packs.js';
import { describeWorkerSandbox } from '../lib/workspace-spec.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import type { ChatMode, LeafProposal } from '../lib/plan-mode.js';
import { planNotice, reviewPlan } from '../lib/plan-review.js';
import { duplicateNotice, newProposals, resolvePersonaNamed, suspectedDuplicates } from '../lib/proposal-merge.js';
import { fittedMaxTokens } from '../lib/sampling.js';
import { composePersonaPrompt } from '../lib/persona-prompt.js';
import { claimNotice, claimService } from '../lib/service-claim.js';
import { estimatePromptComplexity } from '../lib/smart-token-controller.js';
import { openSse, sendFrame, endSse } from '../lib/sse.js';
import { ThoughtFeatureExtractor, predictFailure, updateModelProfile } from '../lib/thinking-classifier.js';
import { resolveTreeType } from '../lib/tree-types.js';
import { conventionsOf, describeConventions } from '../lib/tree-type-conventions.js';
import { withProject } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import type { McpServer } from '../lib/mcp-registry.js';
import type { SearchOutcome } from '../lib/web-tools.js';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '../lib/db-interface.js';
import type { ModelService } from '../services/ModelService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import { withBuiltIns } from '../lib/ownership.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface ChatRouterDeps {
  db: Database;
  modelService: ModelService;
  temporalBridge: TemporalBridge;
  projectRepoService: ProjectRepoService;
  clusterService?: Pick<ClusterService, 'getById' | 'getAll'> | undefined;
  ownedBranches: (userId: string) => Promise<Branch[]>;
  ownedLeaves: (userId: string) => Promise<Leaf[]>;
  ownedTrees: (userId: string) => Promise<Tree[]>;
  webSearch: (query: string) => Promise<SearchOutcome>;
  fetchWebPage: (url: string) => Promise<string>;
  toolRefused: (result: string) => boolean;
}

export function chatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const {
    db, modelService, temporalBridge, projectRepoService, clusterService,
    ownedBranches, ownedLeaves, ownedTrees, webSearch, fetchWebPage, toolRefused,
  } = deps;

  async function extractViaModel(
    extractor: { baseUrl: string; apiKey?: string; provider: { model: string; name: string } },
    turns: { role: string; content: string }[],
    maxProposals: number,
    systemPrompt: string,
  ): Promise<LeafProposal[]> {
    const payloadBase = {
      ...(extractor.provider.model ? { model: extractor.provider.model } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildExtractionPrompt(turns) },
      ],
      template_vars: EXTRACTION_TEMPLATE_VARS,
      temperature: 0.1,
      max_tokens: 800,
      stream: false,
    };

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
          continue;
        }

        const body = (await res.json()) as any;
        const text = String(body?.choices?.[0]?.message?.content ?? '');
        const proposals = parseExtractionResult(text, maxProposals);
        if (proposals.length > 0) return proposals;
        if (text.trim()) return proposals;
      } catch (err: any) {
        console.warn(`[extract] attempt failed for ${extractor.provider.name}: ${err.message}`);
      }
    }

    return [];
  }

  router.post('/', async (req, res) => {
    const { modelId, messages, leafId, branchId, mode: rawMode } = req.body ?? {};
    const mode: ChatMode = isChatMode(rawMode) ? rawMode : 'auto';
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    const uid = userOf(req).id;
    const lastIndex = messages.length - 1;
    const command = parseChatCommand(String(messages[lastIndex]?.content ?? ''));
    const ownAll = await ownedLeaves(uid);
    const branchLeaves = branchId ? ownAll.filter((l) => l.branchId === branchId) : [];

    let siblingLeaves: typeof ownAll = [];
    let siblingBranches: Awaited<ReturnType<typeof ownedBranches>> = [];
    if (branchId) {
      const all = await ownedBranches(uid);
      const branch = all.find((b) => b.id === branchId);
      if (branch?.treeId) {
        siblingBranches = all.filter((b) => b.treeId === branch.treeId && b.id !== branchId);
        const siblingIds = new Set(siblingBranches.map((b) => b.id));
        siblingLeaves = ownAll.filter((l) => siblingIds.has(l.branchId));
      }
    }

    const planTree = branchId
      ? await (async () => {
          const b = (await ownedBranches(uid)).find((x) => x.id === branchId);
          return b?.treeId
            ? (await ownedTrees(uid)).find((t) => t.id === b.treeId)
            : undefined;
        })()
      : undefined;
    const planTreeType = planTree
      ? await resolveTreeType(db, planTree.ownerId, planTree.type)
      : undefined;

    // The tree type's planner-role pack is the only source for this turn's engine — no
    // independently-selected chat pack any more. Off a tree entirely (a bare conversation, or one
    // proposing a new project), koala is the one named, permanent exception.
    const plannerPack = planTreeType
      ? await packForRole(db, uid, planTreeType, 'planner')
      : withBuiltIns(await db.getPersonaPacks(), uid, (p) => p.slug).find((p) => p.slug === 'koala');
    if (!plannerPack) {
      return res.status(409).json({
        error: planTreeType
          ? `"${planTreeType.label}" names no planner pack. Assign one before chatting on this branch.`
          : 'No koala pack found — run the seeder.',
      });
    }

    const ownPersonas = withBuiltIns(await db.getPersonas(), uid, (p) => p.name);
    const chatPersona = ownPersonas.find((p) => p.id === plannerPack.personaId) ?? null;
    const sampling = plannerPack.sampling;
    const budget = plannerPack.budget;
    const promptConfig = plannerPack.prompt;
    const personaPromptText = resolvePrompt(chatPersona);

    const planning = command.command === 'plan' || mode === 'plan';
    const explicitPlan = planning;
    const extracting = planning || mode === 'auto';
    const strategy = estimatePromptComplexity(messages, mode, explicitPlan);
    const offerTools = Boolean(branchId) && mode !== 'chat' && (explicitPlan || strategy.tier !== 'casual');
    const planPrompt = [
      plannerPack.prompt.sections.planning ?? '',
      describeWorkerSandbox(await new WorkspaceImageService(db).list(uid)),
    ].filter(Boolean).join('\n\n');
    const ambientPrompt = plannerPack.prompt.sections.ambientPlanning ?? '';
    const doneMeans = planTreeType?.doneMeans;
    const conventions = conventionsOf(planTreeType);
    const fileConventions = conventions ? describeConventions(conventions) : undefined;
    const toolRegistry = await new ToolService(db).list(uid);
    const grantedNames = plannerPack.tools;
    const planningTools = schemasFor(toolRegistry, grantedNames);
    const activeToolNames = offerTools ? [...grantedNames] : [];
    const historyChars = JSON.stringify(messages).length;
    const personaPrompt = personaPromptText
      ? composePersonaPrompt(budget, promptConfig, personaPromptText, {
          toolRegistry,
          activeTools: activeToolNames,
          historyChars,
          isAdmin: Boolean(userOf(req).isAdmin),
        })
      : undefined;

    const outboundMessages = buildOutboundMessages({
      ...(doneMeans ? { doneMeans } : {}),
      ...(fileConventions ? { fileConventions } : {}),
      messages,
      lastIndex,
      prompt: explicitPlan ? planPrompt : extracting ? ambientPrompt : undefined,
      leaves: branchLeaves,
      siblingLeaves,
      siblingBranches,
      ...(offerTools ? { toolPrompt: promptConfig.sections.toolDiscipline } : {}),
      ...(explicitPlan ? { planText: command.text } : {}),
      ...(personaPrompt ? { personaPrompt } : {}),
    });

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(uid, modelId, plannerPack.model?.endpointId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    const turnRequest = (
      msgs: unknown,
      opts: { tools?: unknown; stream?: boolean; maxTokens: number; reasoningEffort?: string; extra?: Record<string, unknown> },
    ) => buildModelRequest({
      // Which of the pack's own sampler profiles applies — per round, not per route. A round
      // offering tool schemas samples as a tool-turn even in an otherwise conversational branch;
      // a round with none samples as a conversation even in an otherwise tool-heavy one.
      turn: Array.isArray(opts.tools) && opts.tools.length > 0 ? 'tool-turn' : 'conversation',
      ...(sampling ? { sampling } : {}),
      ...(provider.kind ? { kind: provider.kind } : {}),
      messages: msgs,
      ...(opts.tools ? { tools: opts.tools } : {}),
      stream: opts.stream ?? true,
      maxTokens: opts.maxTokens,
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(provider.model ? { model: provider.model } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
    }).body;

    const upstreamAbort = new AbortController();
    res.on('close', () => upstreamAbort.abort());

    // The pack's own wanted MCP servers, resolved once — static for the whole turn. Grove has no
    // session-toggle mechanic (no `enable_mcp_server` grant), so unlike koala's general chat this
    // list never grows mid-turn.
    let servers: McpServer[] = [];
    if (wantsMcp(plannerPack).length) {
      try {
        const reg = new McpRegistryService(db, uid, (n: string) => resolveMcpProbeUrl(n));
        servers = await reg.listWithTools();
        const missing = wantsMcp(plannerPack).filter((n) => !servers.some((s) => s.name === n));
        if (missing.length) {
          console.warn(`[chat] persona named MCP servers that are not usable — ${missing.join(', ')}`);
        }
      } catch (err: any) {
        console.warn(`[chat] could not resolve MCP tools for this turn: ${err.message}`);
      }
    }
    const wantedServerNames = servers.map((s) => s.name);

    const toolsFor = (enabledNames: string[]) => {
      if (!offerTools) return [];
      const remote = servers.filter((s) => enabledNames.includes(s.name)).flatMap((s) => toLoopTools(s.name, s.tools));
      return [...planningTools, ...remote];
    };

    // The pack's own ceiling always wins — a client-supplied max_tokens used to be able to raise
    // it, which is the same "independently overridden" pattern the pack architecture forbids.
    const maxTokensFor = () =>
      fittedMaxTokens(
        budget,
        Math.min(strategy.maxTokens, budget.replyTokens.ceiling),
        JSON.stringify(outboundMessages).length,
      );

    const call = async (reqBody: { messages: unknown[]; tools: string[]; toolChoice?: 'none' }) => {
      const toolSchemas = toolsFor(reqBody.tools);
      const maxTokens = maxTokensFor();
      const body = turnRequest(reqBody.messages, {
        ...(toolSchemas.length ? { tools: toolSchemas } : {}),
        maxTokens,
        reasoningEffort: strategy.reasoningEffort,
        extra: {
          max_completion_tokens: maxTokens,
          stream_options: { include_usage: true },
          ...(reqBody.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
        },
      });
      return fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: upstreamAbort.signal,
      });
    };

    const executeTool = makePackToolExecutor({
      db, userId: uid,
      ...(branchId ? { branchId: String(branchId) } : {}),
      sessionId: String(branchId ?? uid),
      enabledNames: wantedServerNames,
      servers,
      webSearch, fetchWebPage,
      toolRefused,
      projects: projectRepoService,
      temporalBridge,
      clusterService,
      isAdmin: Boolean(userOf(req).isAdmin),
    });

    const targetModelId = provider.model ?? modelId ?? 'default-model';
    const globalProfile = await db.getModelThinkingProfile?.(targetModelId).catch(() => null) ?? undefined;
    const lastUserMsg = messages[messages.length - 1]?.content ?? '';
    const featureExtractor = new ThoughtFeatureExtractor(lastUserMsg);

    // Fed every stream event this turn (not just reasoning) — matches the old per-chunk cadence,
    // which ran the same failure prediction on every chunk regardless of kind.
    const onStreamEvent = (ev: StreamEvent): string | void => {
      if (ev.kind === 'reasoning') featureExtractor.pushReasoning(ev.text);
      const features = featureExtractor.extract();
      /**
       * Pack-governed, not client-suppliable — a request-body override here was the same
       * "independently configured" pattern the persona-pack architecture exists to remove. At the
       * 'medium' sensitivity every pack actually uses, predictFailure's own multiplier (0.85) caps
       * every formulaic path's pFailure below 0.85: n-gram repetition tops out at 0.7225, low
       * entropy at 0.765, overthinking at 0.697 — a 0.85 threshold made the monitor mathematically
       * unable to interrupt a real, literal repetition loop (verified live: an /auto turn stuck
       * repeating "enough enough enough..." never interrupted). 0.65 clears all three at 'medium'.
       */
      const sensitivity = plannerPack.overthinking?.sensitivity ?? 'medium';
      const threshold = plannerPack.overthinking?.failureThreshold ?? 0.65;
      const repeatCap = plannerPack.overthinking?.ngramRepeatCap ?? 5;
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

    openSse(res);

    try {
      const result = await runChatTurn({
        maxRounds: budget.rounds,
        record: budget.record,
        messages: outboundMessages,
        tools: offerTools ? wantedServerNames : [],
        call,
        executeTool,
        onStreamEvent,
        postPasses,
        // Same mechanism chat-pack.ts already uses — an untrimmed, ever-growing tool-loop
        // transcript was a real, independent contributor to the live degeneration reports.
        trimPerRound: (m) => trimConversation(m as any, conversationBudget(budget, provider?.contextTokens)),
        onFrame: (frame) => sendFrame(res, frame),
      });

      const { outcome } = result;
      const wasInterrupted = Boolean(outcome.interrupted);
      const reply = outcome.answer;
      const proposedViaTools = outcome.toolCalls.some((c) => c.name === 'propose_leaf' && c.ok);

      try {
        const finalFeatures = featureExtractor.extract();
        const profileOutcome = wasInterrupted ? 'failure' : 'success';
        const updatedProfile = updateModelProfile(globalProfile, targetModelId, finalFeatures, profileOutcome);
        await db.saveModelThinkingProfile?.(updatedProfile);
      } catch { /* ignored */ }

      const settleProposals = async () => {
        if (!branchId) return;
        const conversation: any[] = [...outboundMessages, { role: 'assistant', content: reply }];
        for (let round = 0; round < MAX_ASSIGNMENT_ROUNDS; round++) {
          const missing = unassignedLeaves(await db.getLeaves(), String(branchId));
          if (!missing.length) break;

          const mine = (await db.getPersonas()).filter((p) => p.ownerId === uid);
          if (!mine.length) break;

          conversation.push({
            role: 'user',
            content: buildAssignmentPrompt(missing, mine, plannerPack.prompt.sections.assignmentNudge ?? ''),
          });
          const retry = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(turnRequest(conversation, {
              tools: planningTools,
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
            const out = await executeTool({ id: c.id, name: c.function.name, arguments: c.function.arguments });
            conversation.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: out.content });
          }
        }

        const stillMissing = unassignedLeaves(await db.getLeaves(), String(branchId));
        if (stillMissing.length) {
          const latest = (await db.getBranches()).find((b: Branch) => b.id === branchId);
          if (latest) await db.saveBranch(withNotice(latest, buildUnassignedNotice(stillMissing)));
          console.warn(`[chat] ${stillMissing.length} leaf(s) on branch ${String(branchId).slice(0, 8)} have no persona`);
        }

        const all = (await ownedLeaves(uid)).filter((l) => l.branchId === branchId);
        const branch = (await db.getBranches()).find((b: Branch) => b.id === branchId);
        const policy: AutoAcceptPolicy = {
          ...DEFAULT_POLICY,
          ...(planTreeType?.autoAccept ?? {}),
          // Branch/tree-type policy, not a client-suppliable override — same reason sampling/
          // tools/budget aren't request-body fields.
          enabled: (branch?.autoAccept ?? planTreeType?.autoAccept?.enabled) === true,
        };
        const reviewed = reviewBatch(all.filter((l) => l.status === 'proposed'), all, policy);

        const started: string[] = [];
        const held: string[] = [];
        for (const { leaf, verdict } of reviewed) {
          if (!verdict.accept) {
            if (policy.enabled) held.push(`${leaf.title} — ${verdict.reason}`);
            continue;
          }
          const acceptOutcome = await acceptLeaf(
            {
              db,
              startLeaf: (l) => temporalBridge!.startLeaf(l),
              signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
            },
            leaf,
            (await ownedLeaves(uid)).filter((l) => l.branchId === branchId),
          );
          if (acceptOutcome.ok) started.push(leaf.title);
          else held.push(`${leaf.title} — ${acceptOutcome.error}`);
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

      if (branchId) {
        try {
          const existing = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === uid);
          const userText = String(messages[lastIndex]?.content ?? '');
          const now = new Date().toISOString();
          const cleanReply = reply.includes('<think>')
            ? reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim() || reply
            : reply;
          const thinking = outcome.thinking.trim();
          const turns: BranchMessage[] = [
            { role: 'user', content: userText },
            { role: 'assistant', content: cleanReply, ...(thinking ? { reasoning: thinking } : {}) },
          ];
          await db.saveBranch({
            ...existing,
            id: String(branchId),
            ownerId: uid,
            title: existing?.title ?? deriveBranchTitle(userText),
            messages: trimTranscript([...(existing?.messages ?? []), ...turns]),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        } catch (err: any) {
          console.warn(`[chat] could not persist transcript for branch ${branchId}: ${err.message}`);
        }

        try {
          let extracted: Awaited<ReturnType<typeof extractViaModel>> | undefined;
          if (extracting && !proposedViaTools) {
            const extractor =
              (await modelService.resolveExtractor(uid).catch(() => undefined)) ??
              { provider, baseUrl, ...(apiKey ? { apiKey } : {}) };
            extracted = await extractViaModel(
              extractor,
              [...messages.slice(0, lastIndex), { role: 'assistant', content: reply }],
              budget.proposalsPerReply,
              plannerPack.prompt.sections.extraction ?? '',
            );
          }
          if (explicitPlan && !reply.trim()) {
            console.warn(`[chat] /plan produced no content for branch ${branchId} — the reply was likely consumed by reasoning before reaching an answer; raise max_tokens`);
          }
          const fromProse = extracted?.length ? extracted : extractProposals(reply, budget.proposalsPerReply);
          const already = (await ownedLeaves(uid))
            .filter((l) => l.branchId === String(branchId))
            .map((l) => l.title);
          const proposals = proposedViaTools ? newProposals(fromProse, already) : newProposals(fromProse, []);
          if (proposedViaTools && proposals.length) {
            console.log(`[chat] branch ${branchId}: ${proposals.length} prose proposal(s) the tool calls did not cover`);
          }
          const now = new Date().toISOString();

          const declaredName = extractServiceName(reply);
          if (declaredName && branchId) {
            const branchRecord = (await ownedBranches(uid)).find((b) => b.id === branchId);
            const tree = branchRecord?.treeId
              ? (await ownedTrees(uid)).find((t) => t.id === branchRecord.treeId)
              : undefined;
            if (tree && !tree.serviceName) {
              const claim = claimService(declaredName, tree, await ownedTrees(uid));
              const adopted = claim.adoptProjectId
                ? withProject({ ...tree, serviceName: declaredName, updatedAt: now }, claim.adoptProjectId)
                : { ...tree, serviceName: declaredName, updatedAt: now };
              await db.saveTree(adopted);
              console.log(
                `[chat] tree ${tree.id}: service named "${declaredName}" by the planner`
                + (claim.adoptProjectId ? ` — adopting the repository of "${claim.ownedBy?.treeName}"` : ''),
              );
              const text = claimNotice(declaredName, claim);
              if (text) {
                const fresh = (await db.getBranches()).find((b) => b.id === String(branchId));
                if (fresh) await db.saveBranch(withNotice(fresh, { text }));
              }
            }
          }
          // Leaf.packId is a PersonaPack id, not a Persona id — this used to resolve against
          // ownedPersonas (a different collection with different ids) and then write the result
          // under a field, `personaId`, that Leaf doesn't even declare. Every prose-extracted
          // proposal ended up with no working assignment at all, regardless of what name the
          // model used — confirmed live: the latest leaf in the DB had exactly this shape.
          const myPacks = withBuiltIns(await db.getPersonaPacks(), uid, (p) => p.slug);
          const myProjects = await projectRepoService.listForOwner(uid);
          for (const proposal of proposals) {
            const assigned = resolvePersonaNamed(proposal.persona, myPacks);
            if (proposal.persona && !assigned) {
              console.warn(`[chat] branch ${branchId}: no persona named "${proposal.persona}" for "${proposal.title}"`);
            }
            await db.saveLeaf({
              id: uuidv4(),
              ownerId: uid,
              branchId: String(branchId),
              title: proposal.title,
              ...(proposal.body ? { body: proposal.body } : {}),
              ...(assigned ? { packId: assigned.id } : {}),
              ...(proposal.mcp?.length ? { mcp: proposal.mcp } : {}),
              ...(proposal.projectId && myProjects.some((p) => p.id === proposal.projectId)
                ? { projectId: proposal.projectId }
                : {}),
              column: 'todo',
              status: 'proposed',
              depth: 0,
              blocking: true,
              createdAt: now,
              updatedAt: now,
            });
          }
          if (proposedViaTools || proposals.length) {
            const onBranch = (await ownedLeaves(uid))
              .filter((l) => l.branchId === String(branchId));
            const declared = (await db.getBranches()).find((b) => b.id === String(branchId))?.acceptance;
            const warnings = [
              planNotice(reviewPlan(onBranch, usableAcceptancePlan(declared).length)),
              duplicateNotice(suspectedDuplicates(onBranch.map((l) => l.title), planTreeType?.duplicateThreshold)),
            ].filter(Boolean).join('\n\n');
            if (warnings) {
              const fresh = (await db.getBranches()).find((b) => b.id === String(branchId));
              if (fresh) await db.saveBranch(withNotice(fresh, { text: warnings }));
            }
          }

          if (proposals.length) await settleProposals();
        } catch (err: any) {
          console.warn(`[chat] could not record proposals for branch ${branchId}: ${err.message}`);
        }
      }

      const totalTokens = outcome.usage?.total_tokens;
      if (typeof totalTokens === 'number' && leafId) {
        try {
          const leaf = (await db.getLeaves()).find((c) => c.id === leafId && c.ownerId === uid);
          if (leaf) {
            await db.saveLeaf({
              ...leaf,
              usage: { ...leaf.usage, tokens: (leaf.usage?.tokens ?? 0) + totalTokens },
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (err: any) {
          console.warn(`[chat] could not record ${totalTokens} tokens against leaf ${leafId}: ${err.message}`);
        }
      }

      endSse(res);
    } catch (err: any) {
      if (upstreamAbort.signal.aborted) return;
      console.warn(`[chat] turn failed: ${err.message}`);
      if (!res.headersSent) return res.status(502).json({ error: err.message });
      try { endSse(res); } catch { /* ignored */ }
    }
  });
  return router;
}
