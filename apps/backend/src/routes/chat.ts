import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
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
import {
  openTurnSse, createOverthinkMonitor, standardPostPasses, stripThinkTags, createTurnAccumulator,
} from '../lib/chat-turn.js';
import type { UnifiedFrame } from '../lib/chat-wire.js';
import { rateLimitedFetch } from '../lib/model-rate-limiter.js';
import { toLoopTools } from '../lib/mcp-tools.js';
import { EXTRACTION_SCHEMA, EXTRACTION_TEMPLATE_VARS, buildExtractionPrompt, extractServiceName, parseExtractionResult } from '../lib/extraction.js';
import { buildOutboundMessages, describeMachineExecution } from '../lib/leaf-context.js';
import { deriveBranchTitle, trimTranscript } from '../lib/leaves.js';
import type { Branch, BranchMessage, Leaf } from '../lib/leaves.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { buildModelRequest } from '../lib/model-request.js';
import { MAX_ASSIGNMENT_ROUNDS, buildAssignmentPrompt, buildUnassignedNotice, unassignedLeaves } from '../lib/persona-assignment.js';
import { resolvePrompt } from '../lib/personas.js';
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
import { sendFrame, endSse } from '../lib/sse.js';
import { resolveTreeType } from '../lib/tree-types.js';
import { conventionsOf, describeConventions } from '../lib/tree-type-conventions.js';
import { withProject, primaryProjectId } from '../lib/trees.js';
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
import type { InfisicalService } from '../services/InfisicalService.js';
import type { PersonaPackService } from '../services/PersonaPackService.js';
import { withBuiltIns } from '../lib/ownership.js';
import type { Conversation, ProposedTree, ProposedSpec } from '../lib/conversations.js';
import { historyForPrompt } from '../lib/koala-context.js';
import { enabledForSession } from '../lib/conversations.js';
import { appendUserTurn } from '../lib/chat-pack-context.js';
import { buildChatCompletionRequest } from '../lib/chat-pack-model-call.js';

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
  packs: PersonaPackService;
  serversFor: (userId: string) => Promise<McpServer[]>;
  ownedConversations: (userId: string) => Promise<Conversation[]>;
  infisicalService?: InfisicalService | undefined;
}

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

async function handleBranchTurn(deps: ChatRouterDeps, req: Request, res: Response) {
  const {
    db, modelService, temporalBridge, projectRepoService, clusterService,
    ownedBranches, ownedLeaves, ownedTrees, webSearch, fetchWebPage, toolRefused,
  } = deps;

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

  const planProjectId = planTree ? primaryProjectId(planTree) : undefined;
  const planProject = planProjectId
    ? (await db.getProjects()).find((p) => p.id === planProjectId && p.ownerId === uid)
    : undefined;
  const planExecutionTarget = planProject?.executionTarget;
  const machineContext = planExecutionTarget?.kind === 'local-device'
    ? await (async () => {
        const device = (await db.getLocalAgentDevices())
          .find((d) => d.id === planExecutionTarget.deviceId && d.ownerId === uid);
        return device
          ? describeMachineExecution(device.name, planExecutionTarget.path)
          : undefined;
      })()
    : undefined;
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
    ...(machineContext ? { machineContext } : {}),
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

  const chatFetch = rateLimitedFetch(
    provider.source === 'endpoint' ? provider.id : undefined,
    uid,
    provider.name,
    fetch,
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
    return chatFetch(`${baseUrl}/chat/completions`, {
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
    isEscalated: false,
  });

  const targetModelId = provider.model ?? modelId ?? 'default-model';
  const lastUserMsg = messages[messages.length - 1]?.content ?? '';
  const monitor = await createOverthinkMonitor({
    db, overthinking: plannerPack.overthinking, targetModelId, seedMessage: lastUserMsg, res,
  });
  const { onStreamEvent } = monitor;
  const postPasses = standardPostPasses(monitor.featureExtractor);

  openTurnSse(res, wantedServerNames);

  const accumulator = createTurnAccumulator(wantedServerNames);
  const onFrame = (frame: UnifiedFrame) => {
    sendFrame(res, frame);
    accumulator.onFrame(frame);
  };

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
      // An untrimmed, ever-growing tool-loop transcript was a real, independent contributor to
      // the live degeneration reports.
      trimPerRound: (m) => trimConversation(m as any, conversationBudget(budget, provider?.contextTokens)),
      onFrame,
    });

    const { outcome } = result;
    const wasInterrupted = Boolean(outcome.interrupted);
    const reply = outcome.answer;
    const proposedViaTools = outcome.toolCalls.some((c) => c.name === 'propose_leaf' && c.ok);

    await monitor.recordOutcome(wasInterrupted);

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
        const { clean: cleanReply, thinking: thinkText } = stripThinkTags(reply);
        const thinking = outcome.thinking.trim() || thinkText;
        const allAttachedServices = [...new Set([...wantedServerNames, ...(outcome.enabledNow ?? [])])];
        const turns: BranchMessage[] = [
          { role: 'user', content: userText },
          {
            role: 'assistant',
            content: cleanReply,
            ...(thinking ? { reasoning: thinking } : {}),
            ...(outcome.toolCalls?.length ? { toolCalls: outcome.toolCalls } : {}),
            ...(allAttachedServices.length ? { enabled: allAttachedServices } : {}),
          },
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
    const aborted = upstreamAbort.signal.aborted;
    if (!aborted) console.warn(`[chat] turn failed: ${err.message}`);

    if (branchId && accumulator.hasContent()) {
      try {
        const existing = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === uid);
        const userText = String(messages[lastIndex]?.content ?? '');
        const now = new Date().toISOString();
        const salvaged: BranchMessage = {
          role: 'assistant',
          ...accumulator.toSalvagedFields(),
          interruptedReason: aborted ? 'Stopped' : `Stopped early: ${err.message}`,
        };
        await db.saveBranch({
          ...existing,
          id: String(branchId),
          ownerId: uid,
          title: existing?.title ?? deriveBranchTitle(userText),
          messages: trimTranscript([...(existing?.messages ?? []), { role: 'user', content: userText }, salvaged]),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      } catch (saveErr: any) {
        console.warn(`[chat] could not save salvaged partial reply for branch ${branchId}: ${saveErr.message}`);
      }
    }

    if (aborted) return;
    if (!res.headersSent) return res.status(502).json({ error: err.message });
    try { endSse(res); } catch { /* ignored */ }
  }
}

async function handleConversationTurn(deps: ChatRouterDeps, req: Request, res: Response) {
  const { db, modelService, packs, ownedConversations } = deps;
  const packFor = async (userId: string, id: string) => packs.resolvePack(userId, id);
  const personaFor = async (userId: string, personaId: string) => packs.resolvePersona(userId, personaId);

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
  let conversation = (await ownedConversations(userId)).find((c) => c.id === String(conversationId));

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

  openTurnSse(res, enabled);

  const upstreamAbort = new AbortController();
  res.on('close', () => upstreamAbort.abort());

  const toolRegistry = await new ToolService(db).list(userId);
  const ownTools = schemasFor(toolRegistry, pack.tools);

  const toolsFor = (enabledNames: string[]) => {
    const remote = servers
      .filter((s) => enabledNames.includes(s.name))
      .flatMap((s) => toLoopTools(s.name, s.tools));
    return [...ownTools, ...remote];
  };

  const chatFetch = rateLimitedFetch(
    provider.source === 'endpoint' ? provider.id : undefined,
    userId,
    provider.name,
    fetch,
  );

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
    return chatFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body as any),
      signal: upstreamAbort.signal,
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
    temporalBridge: deps.temporalBridge,
    ...(deps.infisicalService ? { infisicalService: deps.infisicalService } : {}),
    clusterService: deps.clusterService,
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
  const monitor = await createOverthinkMonitor({
    db, overthinking: pack.overthinking, targetModelId, seedMessage: message, res,
  });
  const { onStreamEvent } = monitor;
  const postPasses = standardPostPasses(monitor.featureExtractor);

  // Mirrors what the frontend's own chat-unified-reducer accumulates from these same frames —
  // kept here too so a turn that never reaches the success path below (Stop, a dropped
  // connection, any error mid-stream) still has something to save. Without this, an interrupted
  // turn's tool calls and partial reply were silently thrown away: nothing between here and the
  // catch block ever persisted them, so they vanished from the conversation on reload and were
  // invisible to the model on the next turn.
  const accumulator = createTurnAccumulator(enabled);
  const onFrame = (frame: UnifiedFrame) => {
    sendFrame(res, frame as any);
    accumulator.onFrame(frame);
  };

  try {
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
      onFrame,
    });

    await monitor.recordOutcome(Boolean(result.outcome.interrupted));

    const ranDry = result.exhaustedRounds && !result.answer && !result.spoken;
    const fallback = `Used all tool rounds without reaching an answer. Ask again to continue.`;
    const assistantContent = result.answer || result.spoken || (ranDry ? fallback : '');
    const { clean: cleanAssistantContent, thinking: thinkText } = stripThinkTags(assistantContent);
    const thinking = (result.outcome.thinking?.trim() || thinkText || '').slice(-20000);

    const accEnabled = accumulator.toSalvagedFields().enabled ?? [];
    const allEnabled = [...new Set([...enabled, ...accEnabled, ...(result.outcome.enabledNow ?? [])])];
    const latestConv = (await db.getConversations()).find((c) => c.id === conversation.id) ?? thread;
    const assistantMsg: any = {
      role: 'assistant',
      content: cleanAssistantContent,
      at: new Date().toISOString(),
      ...(thinking ? { reasoning: thinking } : {}),
      ...(allEnabled.length ? { enabled: allEnabled } : {}),
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
  } catch (err: any) {
    const aborted = upstreamAbort.signal.aborted;
    if (!aborted) console.warn(`[chat] turn failed: ${err.message}`);

    if (accumulator.hasContent()) {
      try {
        const latestConv = (await db.getConversations()).find((c) => c.id === conversation.id) ?? thread;
        const salvagedMsg: any = {
          role: 'assistant',
          at: new Date().toISOString(),
          ...accumulator.toSalvagedFields(),
          interruptedReason: aborted ? 'Stopped' : `Stopped early: ${err.message}`,
        };
        await db.saveConversation({
          ...latestConv,
          messages: [...latestConv.messages, salvagedMsg],
          updatedAt: new Date().toISOString(),
        });
      } catch (saveErr) {
        console.warn(`[chat] could not save salvaged partial reply: ${(saveErr as Error).message}`);
      }
    }

    if (aborted) return;
    if (!res.headersSent) return res.status(502).json({ error: err.message });
    try { endSse(res); } catch { /* ignored */ }
  }
}

export function chatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  router.post('/', asyncRoute(async (req, res) => {
    const { branchId } = req.body ?? {};
    if (branchId) return handleBranchTurn(deps, req, res);
    return handleConversationTurn(deps, req, res);
  }));
  return router;
}
