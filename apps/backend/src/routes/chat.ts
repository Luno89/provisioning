import { Router, type Request } from 'express';
import { acceptLeaf } from '../lib/accept-leaf.js';
import { ToolService } from '../services/ToolService.js';
import { forSurface } from '../lib/tool-catalogue.js';
import { usableAcceptancePlan } from '../lib/acceptance.js';
import { wantsMcp } from '../lib/agent-run.js';
import { DEFAULT_POLICY, reviewBatch } from '../lib/auto-accept.js';
import type { AutoAcceptPolicy } from '../lib/auto-accept.js';
import { withNotice } from '../lib/branch-notice.js';
import { NO_CHAT_MCP, chatMcpFor } from '../lib/chat-mcp.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_TEMPLATE_VARS, buildExtractionPrompt, extractServiceName, parseExtractionResult } from '../lib/extraction.js';
import { buildOutboundMessages } from '../lib/leaf-context.js';
import { ToolCallScanner } from '../lib/leaf-tools.js';
import type { ToolCall } from '../lib/leaf-tools.js';
import { deriveBranchTitle, trimTranscript } from '../lib/leaves.js';
import type { Branch, BranchMessage, Leaf } from '../lib/leaves.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { buildModelRequest } from '../lib/model-request.js';
import { MAX_ASSIGNMENT_ROUNDS, buildAssignmentPrompt, buildUnassignedNotice, unassignedLeaves } from '../lib/persona-assignment.js';
import { resolveConfig } from '../lib/personas.js';
import type { Persona } from '../lib/personas.js';
import { AMBIENT_PROPOSAL_PROMPT, planSystemPrompt, extractProposals, isChatMode, parseChatCommand } from '../lib/plan-mode.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import type { ChatMode, LeafProposal } from '../lib/plan-mode.js';
import { planNotice, reviewPlan } from '../lib/plan-review.js';
import { duplicateNotice, newProposals, resolvePersonaNamed, suspectedDuplicates } from '../lib/proposal-merge.js';
import { fittedMaxTokens } from '../lib/sampling.js';
import { composePersonaPrompt } from '../lib/persona-prompt.js';
import { claimNotice, claimService } from '../lib/service-claim.js';
import { FinishReasonScanner, estimatePromptComplexity } from '../lib/smart-token-controller.js';
import { forwardChunk, sendFrame } from '../lib/sse.js';
import { ReasoningScanner, ThoughtFeatureExtractor, predictFailure, updateModelProfile } from '../lib/thinking-classifier.js';
import { ContentScanner, UsageScanner } from '../lib/token-usage.js';
import { resolveTreeType } from '../lib/tree-types.js';
import { conventionsOf, describeConventions } from '../lib/tree-type-conventions.js';
import { withProject } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';
import type { ModelService } from '../services/ModelService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import { defaultSampling, requireBudget, requirePrompt } from '../lib/pack-defaults.js';

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
  runLeafTool: (userId: string, branchId: string, call: { name: string; arguments: any }) => Promise<any>;
  toolRefused: (result: string) => boolean;
}

export function chatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const {
    db, modelService, temporalBridge, projectRepoService,
    ownedPersonas, ownedBranches, ownedLeaves, ownedTrees, runLeafTool, toolRefused,
  } = deps;

  async function extractViaModel(
    extractor: { baseUrl: string; apiKey?: string; provider: { model: string; name: string } },
    turns: { role: string; content: string }[],
    maxProposals: number,
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
    const { modelId, messages, stream = true, leafId, branchId, mode: rawMode, packId, ...rest } = req.body ?? {};
    const mode: ChatMode = isChatMode(rawMode) ? rawMode : 'auto';
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    const lastIndex = messages.length - 1;
    const command = parseChatCommand(String(messages[lastIndex]?.content ?? ''));
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

    const uid = (req as any).user.id;
    const chatPack = packId
      ? (await db.getPersonaPacks()).find((p) => (p.id === String(packId) || p.slug === String(packId))
          && (p.ownerId === undefined || p.ownerId === uid)) ?? null
      : null;
    if (packId && !chatPack) {
      return res.status(404).json({ error: 'No such pack' });
    }
    const chatPersona = chatPack
      ? (await db.getPersonas()).find((p) => p.id === chatPack.personaId) ?? null
      : null;
    /**
     * A turn with no pack named still has to sample somehow. It falls back to the shipped koala
     * row — a record the user can edit — rather than the module constant it used to compose, so
     * there is no configuration left that only exists in code.
     */
    const sampling = chatPack?.sampling ?? await defaultSampling(db);
    const budget = chatPack?.budget ?? await requireBudget(db);
    const promptConfig = chatPack?.prompt ?? await requirePrompt(db);
    const resolved = resolveConfig(
      await db.getHarnessProfile(uid),
      chatPack,
      rest,
      chatPersona,
    );

    const planning = command.command === 'plan' || mode === 'plan';
    const explicitPlan = planning;
    const extracting = planning || mode === 'auto';
    const strategy = estimatePromptComplexity(messages, mode, explicitPlan);
    const offerTools = Boolean(branchId) && mode !== 'chat' && (explicitPlan || strategy.tier !== 'casual');
    const planTree = branchId
      ? await (async () => {
          const b = (await ownedBranches((req as any).user.id)).find((x) => x.id === branchId);
          return b?.treeId
            ? (await ownedTrees((req as any).user.id)).find((t) => t.id === b.treeId)
            : undefined;
        })()
      : undefined;
    const planTreeType = planTree
      ? await resolveTreeType(db, planTree.ownerId, planTree.type)
      : undefined;
    const doneMeans = planTreeType?.doneMeans;
    const conventions = conventionsOf(planTreeType);
    const fileConventions = conventions ? describeConventions(conventions) : undefined;
    const toolRegistry = await new ToolService(db).list(uid);
    const images = await new WorkspaceImageService(db).list(uid);
    // The planning surface, from the catalogue — LEAF_TOOLS was a second list of the same thing.
    const planningTools = forSurface(toolRegistry, 'planning');
    const activeToolNames = offerTools
      ? (chatPack?.tools?.length ? chatPack.tools : planningTools.map((t) => t.function.name))
      : [];
    const historyChars = JSON.stringify(messages).length;
    const personaPrompt = resolved.systemPrompt
      ? composePersonaPrompt(budget, promptConfig, resolved.systemPrompt, {
          toolRegistry,
          activeTools: activeToolNames,
          historyChars,
          isAdmin: Boolean((req as any).user?.isAdmin),
        })
      : undefined;

    const outboundMessages = buildOutboundMessages({
      ...(doneMeans ? { doneMeans } : {}),
      ...(fileConventions ? { fileConventions } : {}),
      messages,
      lastIndex,
      prompt: explicitPlan ? planSystemPrompt(images) : extracting ? AMBIENT_PROPOSAL_PROMPT : undefined,
      leaves: branchLeaves,
      siblingLeaves,
      siblingBranches,
      ...(offerTools ? { toolPrompt: promptConfig.sections.toolDiscipline } : {}),
      ...(explicitPlan ? { planText: command.text } : {}),
      ...(personaPrompt ? { personaPrompt } : {}),
    });

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl((req as any).user.id, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    const turnRequest = (
      messages: unknown,
      opts: { tools?: unknown; stream: boolean; maxTokens: number; reasoningEffort?: string; extra?: Record<string, unknown> },
    ) => buildModelRequest({
      turn: 'conversation',
      ...(sampling ? { sampling } : {}),
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

    const upstreamAbort = new AbortController();
    res.on('close', () => upstreamAbort.abort());

    try {
    let chatMcp = NO_CHAT_MCP;
    try {
      if (wantsMcp(chatPack).length) {
        const reg = new McpRegistryService(db, (req as any).user.id, (n: string) => resolveMcpProbeUrl(n));
        chatMcp = chatMcpFor(chatPack, await reg.listWithTools(), (srv, tool, a) => reg.call(srv, tool, a));
        if (chatMcp.missing.length) {
          console.warn(`[chat] persona named MCP servers that are not usable — ${chatMcp.missing.join(', ')}`);
        }
      }
    } catch (err: any) {
      console.warn(`[chat] could not resolve MCP tools for this turn: ${err.message}`);
    }
    const turnTools = chatMcp.tools.length ? [...planningTools, ...chatMcp.tools] : planningTools;

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(turnRequest(outboundMessages, {
          ...(offerTools ? { tools: turnTools } : {}),
          stream,
          maxTokens: fittedMaxTokens(budget, rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
          reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
          extra: {
            max_completion_tokens: fittedMaxTokens(budget, rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            ...(stream ? { stream_options: { include_usage: true } } : {}),
          },
        })),
        signal: upstreamAbort.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({ error: detail || `Model returned HTTP ${upstream.status}` });
      }

      res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const targetModelId = provider.model ?? modelId ?? 'default-model';
      const globalProfile = await db.getModelThinkingProfile?.(targetModelId).catch(() => null) ?? undefined;
      const lastUserMsg = messages[messages.length - 1]?.content ?? '';
      const featureExtractor = new ThoughtFeatureExtractor(lastUserMsg);

      const scanner = new UsageScanner();
      const content = branchId ? new ContentScanner() : undefined;
      const finishScanner = new FinishReasonScanner();
      const reasoningScanner = new ReasoningScanner();
      const decoder = new TextDecoder();
      let wasInterrupted = false;

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

      const conversation: any[] = [...outboundMessages];

      let proposedViaTools = false;

      for (let round = 0; round < budget.rounds && calls.length > 0 && branchId; round++) {
        conversation.push({
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of calls) {
          const remote = await chatMcp.call(call.name, JSON.parse(call.arguments || '{}'));
          if (remote) {
            conversation.push({
              role: 'tool', tool_call_id: call.id, name: call.name,
              content: JSON.stringify({ ...(remote.isError ? { error: remote.text } : { result: remote.text }) }),
            });
            continue;
          }
          const result = await runLeafTool((req as any).user.id, String(branchId), call);
          if (call.name === 'propose_leaf' && !toolRefused(result)) proposedViaTools = true;
          conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
        }

        const followUp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(turnRequest(conversation, {
            tools: turnTools,
            stream: true,
          maxTokens: fittedMaxTokens(budget, rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: {
              max_completion_tokens: fittedMaxTokens(budget, rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
              stream_options: { include_usage: true },
            },
          })),
          signal: upstreamAbort.signal,
        });
        if (!followUp.ok || !followUp.body) break;
        calls = await pump(followUp.body);
      }

      const settleProposals = async () => {
        if (!branchId) return;
        for (let round = 0; round < MAX_ASSIGNMENT_ROUNDS; round++) {
          const missing = unassignedLeaves(await db.getLeaves(), String(branchId));
          if (!missing.length) break;

          const mine = (await db.getPersonas()).filter((p) => p.ownerId === (req as any).user.id);
          if (!mine.length) break;

          conversation.push({ role: 'user', content: buildAssignmentPrompt(missing, mine) });
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
            const out = await runLeafTool((req as any).user.id, String(branchId), { name: c.function.name, arguments: c.function.arguments });
            conversation.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: out });
          }
        }

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

      if (calls.length > 0 && branchId) {
        sendFrame(res, { interruptedReason: `Used all ${budget.rounds} research steps — answering with what was found.` });
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
          maxTokens: fittedMaxTokens(budget, rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: { stream_options: { include_usage: true } },
          })),
          signal: upstreamAbort.signal,
        });
        if (finalPass.ok && finalPass.body) await pump(finalPass.body);
      }

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

      try {
        const finalFeatures = featureExtractor.extract();
        const outcome = wasInterrupted ? 'failure' : 'success';
        const updatedProfile = updateModelProfile(globalProfile, targetModelId, finalFeatures, outcome);
        await db.saveModelThinkingProfile?.(updatedProfile);
      } catch { /* ignored */ }

      if (content && branchId) {
        try {
          const reply = content.result();

          try {
            const existing = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === (req as any).user.id);
            const userText = String(messages[lastIndex]?.content ?? '');
            const now = new Date().toISOString();
            const cleanReply = reply.includes('<think>')
              ? reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim() || reply
              : reply;
            const thinking = reasoningScanner.result().trim();
            const turns: BranchMessage[] = [
              { role: 'user', content: userText },
              { role: 'assistant', content: cleanReply, ...(thinking ? { reasoning: thinking } : {}) },
            ];
            await db.saveBranch({
              ...existing,
              id: String(branchId),
              ownerId: (req as any).user.id,
              title: existing?.title ?? deriveBranchTitle(userText),
              messages: trimTranscript([...(existing?.messages ?? []), ...turns]),
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            });
          } catch (err: any) {
            console.warn(`[chat] could not persist transcript for branch ${branchId}: ${err.message}`);
          }

          let extracted: Awaited<ReturnType<typeof extractViaModel>> | undefined;
          if (extracting && !proposedViaTools) {
            const extractor =
              (await modelService.resolveExtractor((req as any).user.id).catch(() => undefined)) ??
              { provider, baseUrl, ...(apiKey ? { apiKey } : {}) };
            extracted = await extractViaModel(
              extractor,
              [...messages.slice(0, lastIndex), { role: 'assistant', content: reply }],
              budget.proposalsPerReply,
            );
          }
          if (explicitPlan && !reply.trim()) {
            console.warn(`[chat] /plan produced no content for branch ${branchId} — the reply was likely consumed by reasoning before reaching an answer; raise max_tokens`);
          }
          const fromProse = extracted?.length ? extracted : extractProposals(reply, budget.proposalsPerReply);
          const already = (await ownedLeaves((req as any).user.id))
            .filter((l) => l.branchId === String(branchId))
            .map((l) => l.title);
          const proposals = proposedViaTools ? newProposals(fromProse, already) : newProposals(fromProse, []);
          if (proposedViaTools && proposals.length) {
            console.log(`[chat] branch ${branchId}: ${proposals.length} prose proposal(s) the tool calls did not cover`);
          }
          const now = new Date().toISOString();

          const declaredName = extractServiceName(reply);
          if (declaredName && branchId) {
            const branchRecord = (await ownedBranches((req as any).user.id)).find((b) => b.id === branchId);
            const tree = branchRecord?.treeId
              ? (await ownedTrees((req as any).user.id)).find((t) => t.id === branchRecord.treeId)
              : undefined;
            if (tree && !tree.serviceName) {
              const claim = claimService(declaredName, tree, await ownedTrees((req as any).user.id));
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
            const onBranch = (await ownedLeaves((req as any).user.id))
              .filter((l) => l.branchId === String(branchId));
            const declared = (await db.getBranches()).find((b) => b.id === String(branchId))?.acceptance;
            const warnings = [
              planNotice(reviewPlan(onBranch, usableAcceptancePlan(declared).length)),
              duplicateNotice(suspectedDuplicates(onBranch.map((l) => l.title))),
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
      if (upstreamAbort.signal.aborted) return;
      if (!res.headersSent) return res.status(502).json({ error: err.message });
      res.end();
    }
  });
  return router;
}
