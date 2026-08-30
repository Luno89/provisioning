import {
  conversationBudget,
  buildAgentPrompt,
  clampToolResult,
  codePacing,
  pacingNoteFor,
  trimConversation,
  toolsForStep,
  type PacingNote,
  type ToolWithdrawal,
} from './sandbox-tools.js';
import { parseToolArguments, ToolCallScanner, WEB_TOOL_NAMES } from './leaf-tools.js';
import {
  shouldCheckpoint, parseHandoff, assembleResetPrompt, HANDOFF_TOOL, type Handoff,
} from './leaf-checkpoint.js';
import { extensionNotice } from './budget-extension.js';
import { isProductive, thrashAction, nudgeMessage, thrashSummary } from './thrash.js';
import { UniversalValidatorService } from '../services/UniversalValidatorService.js';
import type { ValidationRecipe } from './tree-types.js';
import { detectThoughtLoop, type Turn as ThoughtTurn } from './thought-loop.js';
import { TOOL_REPOSITORY, formatToolRepoForOpenAI } from './tool-repository.js';
import { renderSearchOutcome } from './web-tools.js';
import type { WorkspaceLanguage, WorkspaceSpec } from './workspace-spec.js';
import type { ModelKind } from './model-registry.js';
import type { WebTools } from './web-tools.js';
import {
  turnMaxTokens, fittedMaxTokens,
} from './sampling.js';
import { type Overrides } from './tunables.js';
import { buildModelRequest } from './model-request.js';
import type { AgentStep, AgentRequest, ConversationMessage } from '@koala/harness-types';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import type { BudgetConfig, SamplingConfig } from '@koala/harness-types';
import type { RanAs } from './run-provenance.js';

export type { AgentStep, AgentRequest, ConversationMessage };

export interface SandboxDriver {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export type ExtendBudgetDriver = (input: {
  exhausted: 'steps' | 'tokens';
  extensionsUsed: number;
  step: number;
  tokensUsed: number;
  originalMaxSteps: number;
  originalMaxTokens: number;
  thrashing: boolean;
  circling: boolean;
  silent: boolean;
}) => Promise<{ steps?: number; tokens?: number; reason: string } | undefined>;

export type CheckpointDriver = (input: {
  number: number;
  handoff?: Handoff | undefined;
  tokensUsed: number;
  maxTokens: number;
}) => Promise<{ artifact: string; sha?: string; branch?: string } | undefined>;

export interface AgentRunResult {
  succeeded: boolean;
  summary: string;
  tokensUsed: number;
  completionTokensUsed: number;
  outOfBudget?: boolean;
  stoppedBecause?: 'circling' | 'thrashing' | 'silent' | 'budget';
  steps: number;
  request: AgentRequest;
  transcript: string[];
  trace?: AgentStep[];
  conversation?: ConversationMessage[];
  checkpoints?: { step: number; tokensUsed: number; sha?: string; branch?: string }[];
  extensions?: { step: number; at: 'steps' | 'tokens'; steps?: number; tokens?: number; reason: string }[];
  unsupported?: string[];
}

export interface AgentRunOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string | undefined;
  language?: WorkspaceLanguage | undefined;
  taskContext: string;
  sandbox: SandboxDriver;
  maxSteps?: number;
  maxTokens?: number;
  kind?: ModelKind | undefined;
  overrides?: Overrides | undefined;
  fromProfile?: string[] | undefined;
  fromPersona?: string[] | undefined;
  fromPack?: string[] | undefined;
  checkpoint?: CheckpointDriver | undefined;
  extendBudget?: ExtendBudgetDriver | undefined;
  saveMemory?: ((memory: {
    category: string;
    title: string;
    text: string;
    suggestedScope: 'project' | 'global';
  }) => Promise<{ action: string }>) | undefined;
  web?: WebTools | undefined;
  allowTools?: string[] | undefined;
  remoteTools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] | undefined;
  /**
   * The tool catalogue this run may draw on, read from the database by the caller.
   *
   * Passed in rather than imported: this module has no database, and reading `TOOL_REPOSITORY`
   * here meant a leaf was offered the compiled-in descriptions no matter what the catalogue said.
   * Absent falls back to the constant, which is what a caller with no database does.
   */
  catalogue?: { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }[] | undefined;
  /** The caller's workspace images, for the same reason: the sandbox description is a row read. */
  images?: readonly WorkspaceImageSpec[] | undefined;
  /** The pack's sampler. Absent sends none, rather than a base layer from a module. */
  sampling?: SamplingConfig | undefined;
  /** The pack's budget — what this run may spend and what the model is shown. */
  budget: BudgetConfig;
  /** What the run was configured by, copied into the record. */
  ranAs?: RanAs | undefined;
  callRemote?: ((name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | undefined>) | undefined;
  pacing?: PacingNote[] | undefined;
  withdrawTools?: ToolWithdrawal | undefined;
  think?: boolean;
  captureTrace?: boolean;
  onStep?: (step: AgentStep) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  memoryContext?: string;
  bindingsContext?: string;
  sandboxSpec?: Pick<WorkspaceSpec, 'egress' | 'env' | 'cpu' | 'memory'>;
  contextTokens?: number;
  validationRecipe?: ValidationRecipe | undefined;
}

/**
 * A tool this loop dispatches itself, rather than routing to a remote service.
 *
 * Read from the catalogue's sandbox surface. It was `SANDBOX_TOOLS`, which declared five of the
 * eleven this loop actually handles — so six of its own tools did not count as built-in.
 */
const isBuiltInTool = (name: string) =>
  TOOL_REPOSITORY.some((t) => t.name === name && t.surfaces?.includes('sandbox')) || name === 'finish';

export async function runAgentLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const overrides = opts.overrides ?? {};

  const think = typeof overrides.think === 'boolean' ? overrides.think : Boolean(opts.think);
  let maxSteps = typeof overrides.maxSteps === 'number'
    ? overrides.maxSteps
    : (opts.maxSteps ?? opts.budget.run.steps);
  let maxTokens = typeof overrides.maxTokens === 'number'
    ? overrides.maxTokens
    : (opts.maxTokens ?? opts.budget.run.tokens);
  const originalMaxSteps = maxSteps;
  const originalMaxTokens = maxTokens;
  const toolResultCap = typeof overrides.maxToolResultChars === 'number'
    ? overrides.maxToolResultChars
    : undefined;
  const model = typeof overrides.model === 'string' ? overrides.model : opts.model;

  const transcript: string[] = [];
  const trace: AgentStep[] = [];
  let tokensUsed = 0;
  let completionTokensUsed = 0;
  let consecutiveNoToolTurns = 0;

  const useMemories = typeof overrides.useMemories === 'boolean' ? overrides.useMemories : true;
  const memoryContext = useMemories && opts.memoryContext ? opts.memoryContext.trim() : '';

  const custom = typeof overrides.systemPrompt === 'string' && overrides.systemPrompt.trim()
    ? overrides.systemPrompt
    : '';
  const extra = typeof overrides.extraInstructions === 'string' && overrides.extraInstructions.trim()
    ? overrides.extraInstructions
    : '';
  const systemPrompt = [
    custom || buildAgentPrompt(opts.images ?? [], opts.language, opts.taskContext, maxSteps, opts.sandboxSpec ?? {}),
    ...(custom ? ['', 'YOUR TASK', opts.taskContext] : []),
    ...(extra ? ['', extra] : []),
    ...(opts.bindingsContext ? ['', opts.bindingsContext.trim()] : []),
    ...(memoryContext ? ['', memoryContext] : []),
  ].join('\n');

  const messages: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Begin. Start by looking at what is in the workspace.' },
  ];

  /**
   * Only what this loop can actually dispatch.
   *
   * It used to offer the WHOLE registry -- 51 tools -- while handling 13, so a leaf was shown
   * `deploy_project` and every other assistant tool and got `Unknown tool` if it called one. The
   * catalogue says which surface offers a tool; the sandbox surface is this loop's own set.
   */
  const toolRepoOpenAI = opts.catalogue ?? formatToolRepoForOpenAI(
    TOOL_REPOSITORY.filter((t) => t.surfaces?.includes('sandbox')),
  );
  const toolMap = new Map<string, any>();
  for (const t of toolRepoOpenAI) {
    if (!toolMap.has(t.function.name)) {
      toolMap.set(t.function.name, t);
    }
  }
  if (opts.web) {
    const web = formatToolRepoForOpenAI(
      TOOL_REPOSITORY.filter((t) => (WEB_TOOL_NAMES as readonly string[]).includes(t.name)),
    );
    for (const t of web) toolMap.set(t.function.name, t);
  }
  const offered = Array.from(toolMap.values());
  for (const remote of opts.remoteTools ?? []) {
    if (!toolMap.has(remote.function.name)) offered.push(remote);
  }
  const activeTools = opts.allowTools?.length
    ? offered.filter((t) => opts.allowTools!.includes(t.function.name))
    : offered;

  const turnCap = turnMaxTokens(opts.budget.replyTokens, {
    think,
    canWriteFiles: activeTools.some((t) => (t.function?.name || t.name) === 'write_file'),
  });
  const TRUNCATION_MARGIN = 40;

  const { body: requestBody, unsupported } = buildModelRequest({
    turn: 'tool-turn',
    ...(opts.sampling ? { sampling: opts.sampling } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    messages,
    tools: activeTools,
    stream: true,
    maxTokens: turnCap,
    ...(model ? { model } : {}),
    overrides: { ...(think ? {} : { think: false }), ...overrides },
    extra: { stream_options: { include_usage: true } },
  });

  const { messages: _messages, tools: _tools, ...parameters } = requestBody;
  const request: AgentRequest = {
    systemPrompt,
    kickoff: String(messages[1]?.content ?? ''),
    model,
    tools: activeTools.map((t) => ({ name: t.function.name || t.name, description: t.function.description || t.description })),
    parameters,
    overrides,
    unsupported,
    ...(opts.fromProfile?.length ? { fromProfile: opts.fromProfile } : {}),
    ...(opts.fromPersona?.length ? { fromPersona: opts.fromPersona } : {}),
    ...(opts.fromPack?.length ? { fromPack: opts.fromPack } : {}),
    ...(opts.ranAs ? { ranAs: opts.ranAs } : {}),
    loop: {
      maxSteps,
      think,
      toolResultCap: toolResultCap ?? opts.budget.toolResultChars,
    },
  };

  let stoppedTalking = false;
  let stoppedAtStep = maxSteps;

  const oneToolTurn = async (
    toolName: string,
    instruction?: string,
    toolDeclaration?: unknown,
  ): Promise<{ args?: Record<string, unknown>; content: string } | undefined> => {
    const tool = toolDeclaration
      ?? activeTools.find((t: any) => (t.function?.name ?? t.name) === toolName);
    if (!tool) return undefined;

    if (instruction) messages.push({ role: 'user', content: instruction });

    try {
      const body = {
        ...requestBody,
        messages,
        tools: [tool],
        max_tokens: fittedMaxTokens(opts.budget, 1200, JSON.stringify(messages).length, opts.contextTokens),
      };
      const res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) return undefined;

      const reply = await readStreamedReply(res);
      tokensUsed += reply.tokens;
      completionTokensUsed += reply.completionTokens;

      const call = reply.toolCalls.find((c) => c.name === toolName);
      const content = reply.content?.trim() ?? '';
      if (!call) return { content };
      return { args: parseToolArguments(call.arguments), content };
    } catch {
      return undefined;
    }
  };
  const extensions: { step: number; at: 'steps' | 'tokens'; steps?: number; tokens?: number; reason: string }[] = [];
  let extensionsUsed = 0;
  const checkpoints: { step: number; tokensUsed: number; sha?: string; branch?: string }[] = [];
  let unproductiveTurns = 0;
  let thrashed = false;
  const thoughts: ThoughtTurn[] = [];
  let circling = '';
  let wrapUpProse = '';

  let exhausted: 'steps' | 'tokens' | undefined;

  for (let step = 0; ; step++) {
    const hit = tokensUsed >= maxTokens ? 'tokens' : step >= maxSteps ? 'steps' : undefined;
    if (hit) {
      const extension = opts.extendBudget
        ? await opts.extendBudget({
          exhausted: hit,
          extensionsUsed,
          step,
          tokensUsed,
          originalMaxSteps,
          originalMaxTokens,
          thrashing: thrashed || unproductiveTurns > 0,
          circling: Boolean(circling),
          silent: consecutiveNoToolTurns > 0,
        }).catch(() => undefined)
        : undefined;

      if (!extension) {
        exhausted = hit;
        stoppedAtStep = step;
        break;
      }

      extensionsUsed++;
      if (extension.steps) maxSteps += extension.steps;
      if (extension.tokens) maxTokens += extension.tokens;
      extensions.push({
        step,
        at: hit,
        ...(extension.steps ? { steps: extension.steps } : {}),
        ...(extension.tokens ? { tokens: extension.tokens } : {}),
        reason: extension.reason,
      });
      transcript.push(`budget extended (${hit}): ${extension.reason}`);

      messages.push({
        role: 'user',
        content: extensionNotice(extension, hit === 'steps' ? maxSteps : maxTokens, hit),
      });
    }
    if (opts.checkpoint && shouldCheckpoint({ tokensUsed, maxTokens, taken: checkpoints.length })) {
      const number = checkpoints.length + 1;
      const triggeredAt = tokensUsed;
      const before = messages.length;
      const turn = await oneToolTurn(
        'handoff',
        'Pause. Your context is about to be reset so you can keep working without running out of '
        + 'room — your work is safe and is being committed now. Call `handoff` to write down where '
        + 'things stand. Be specific: what is genuinely finished, what comes next, and anything you '
        + 'found out that would not be obvious from the diff. Do not call any other tool.',
        HANDOFF_TOOL,
      );
      const handoff = turn?.args ? parseHandoff(turn.args) : undefined;

      const saved = await opts.checkpoint({ number, handoff, tokensUsed: triggeredAt, maxTokens })
        .catch(() => undefined);

      if (saved) {
        checkpoints.push({
          step,
          tokensUsed: triggeredAt,
          ...(saved.sha ? { sha: saved.sha } : {}),
          ...(saved.branch ? { branch: saved.branch } : {}),
        });
        transcript.push(`checkpoint ${number}: ${saved.sha ?? 'saved'}`);

        const system = messages[0];
        messages.length = 0;
        if (system) messages.push(system);
        messages.push({
          role: 'user',
          content: assembleResetPrompt(opts.taskContext.split('\n')[0] ?? 'this task', saved.artifact),
        });
      } else {
        messages.length = before;
      }
    }

    requestBody.messages = trimConversation(
      messages,
      conversationBudget(opts.budget, opts.contextTokens, typeof overrides.conversationGrowth === 'number' ? overrides.conversationGrowth : undefined),
    );
    requestBody.max_tokens = fittedMaxTokens(opts.budget, turnCap, JSON.stringify(requestBody.messages).length, opts.contextTokens);
    requestBody.tools = toolsForStep(step, activeTools, opts.withdrawTools);

    const response = await doFetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(requestBody),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`Model call failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }

    const { content, reasoning, toolCalls, tokens, completionTokens } = await readStreamedReply(response);
    tokensUsed += tokens;
    completionTokensUsed += completionTokens;

    const record: AgentStep | undefined = opts.captureTrace || opts.onStep
      ? {
          step: step + 1,
          ...(reasoning ? { reasoning: clip(reasoning, opts.budget.record.traceReasoning) } : {}),
          ...(content ? { content: clip(content, opts.budget.record.traceContent) } : {}),
          toolCalls: toolCalls.map((c) => ({ name: c.name, arguments: clipHead(c.arguments, opts.budget.record.traceToolArgs) })),
          toolResults: [],
          tokens,
          ...(reasoning.length > opts.budget.record.traceReasoning
          || content.length > opts.budget.record.traceContent
          || toolCalls.some((c) => c.arguments.length > opts.budget.record.traceToolArgs)
            ? { truncated: true }
            : {}),
        }
      : undefined;
    if (record && opts.captureTrace) trace.push(record);

    const publish = () => {
      if (!record || !opts.onStep) return;
      try {
        opts.onStep(record);
      } catch { /* ignored */ }
    };

    messages.push({
      role: 'assistant',
      content,
      ...(toolCalls.length
        ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    });

    if (!toolCalls.length) {
      if (completionTokens > 0 && completionTokens >= turnCap - TRUNCATION_MARGIN) {
        messages.push({
          role: 'user',
          content: 'Your last tool call was cut off because it exceeded the length limit for a '
            + 'single reply, so nothing ran. If you were writing a file, write it in SEVERAL '
            + 'smaller steps — one section per call, appending — or split it into smaller modules. '
            + 'Do not resend the same oversized call.',
        });
        publish();
        continue;
      }
      consecutiveNoToolTurns++;
      publish();
      if (consecutiveNoToolTurns >= 3 || step >= maxSteps - 1) {
        stoppedTalking = consecutiveNoToolTurns >= 3;
        stoppedAtStep = step + 1;
        break;
      }
      messages.push({
        role: 'user',
        content: 'Use a tool, or call `finish` if the task is complete or you are stuck.',
      });
      continue;
    }

    consecutiveNoToolTurns = 0;

    thoughts.push({
      ...(reasoning || content ? { thought: `${reasoning ?? ''} ${content ?? ''}`.trim() } : {}),
      ...(toolCalls.length ? { action: toolCalls.map((c) => `${c.name} ${c.arguments}`).join(' ') } : {}),
    });
    const loop = detectThoughtLoop(thoughts);
    if (loop.looping) {
      circling = loop.reason;
      stoppedAtStep = step + 1;
      publish();
      break;
    }

    if (isProductive(toolCalls)) {
      unproductiveTurns = 0;
    } else {
      unproductiveTurns++;
      const action = thrashAction(unproductiveTurns);
      if (action === 'stop') {
        thrashed = true;
        stoppedAtStep = step + 1;
        publish();
        break;
      }
      if (action === 'nudge') {
        messages.push({ role: 'user', content: nudgeMessage(unproductiveTurns, transcript) });
      }
    }

    for (const call of toolCalls) {
      const name = call.name;
      const args = parseToolArguments(call.arguments);

      if (name === 'finish') {
        const summaryStr = String(args.summary ?? '').slice(0, 4000) || 'No summary given.';
        transcript.push(`finish: succeeded=${Boolean(args.succeeded)} summary=${summaryStr}`);
        publish();
        return {
          succeeded: Boolean(args.succeeded),
          summary: summaryStr,
          tokensUsed,
          completionTokensUsed,
          steps: step + 1,
          request,
          transcript,
          ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages, opts.budget.messageChars) } : {}),
          ...(checkpoints.length ? { checkpoints } : {}),
          ...(extensions.length ? { extensions } : {}),
          ...(unsupported.length ? { unsupported } : {}),
        };
      }

      let result: string;
      try {
        const remote = opts.callRemote && !isBuiltInTool(name)
          ? await opts.callRemote(name, args)
          : undefined;
        if (remote) {
          transcript.push(`${name} -> ${remote.isError ? 'error' : 'ok'}`);
          result = remote.text;
        } else {
          result = await runSandboxTool(
            opts.sandbox,
            name,
            args,
            transcript,
            opts.web,
            opts.saveMemory,
            opts.validationRecipe,
            opts.fetchImpl,
          );
        }
      } catch (err: any) {
        result = JSON.stringify({ error: String(err?.message ?? err).slice(0, 500) });
      }

      record?.toolResults.push({ name, result: clip(result, opts.budget.record.traceToolResult) });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: clampToolResult(result, toolResultCap ?? opts.budget.toolResultChars),
      });
    }

    const remaining = maxSteps - (step + 1);
    const note = pacingNoteFor(remaining, opts.pacing ?? codePacing(opts.budget.run.wrapUpSteps));
    if (note) {
      const last = messages[messages.length - 1] as { content?: string };
      last.content = `${last.content ?? ''}\n\n[${remaining} step${remaining === 1 ? '' : 's'} left of ${maxSteps}. `
        + `${note.message}]`;
    }

    publish();
  }

  if (!thrashed && !stoppedTalking && !circling) {
    const spent = `You have used your whole budget for this task (${stoppedAtStep} steps, `
      + `${tokensUsed.toLocaleString()} tokens).`;
    messages.push({
      role: 'user',
      content: `${spent} Stop working and call \`finish\` now.\n\n`
        + 'Report honestly. If you completed the task — including if you already committed and '
        + 'pushed the work — call finish with succeeded true and say what you did and where it is. '
        + 'If you did not finish, call finish with succeeded false and say exactly what is done, '
        + 'what is not, and what the next attempt should do differently. Do not call any other tool.',
    });

    const wrapUpTurn = await oneToolTurn('finish');
    if (!wrapUpTurn?.args && wrapUpTurn?.content) {
      wrapUpProse = wrapUpTurn.content.slice(0, 2000);
    }
    const wrapUp = wrapUpTurn?.args
      ? {
        succeeded: Boolean(wrapUpTurn.args.succeeded),
        summary: String(wrapUpTurn.args.summary ?? '').slice(0, 4000) || 'No summary given.',
      }
      : undefined;
    if (wrapUp) {
      transcript.push(`finish (forced): succeeded=${wrapUp.succeeded} summary=${wrapUp.summary}`);
      return {
        succeeded: wrapUp.succeeded,
        summary: wrapUp.summary,
        tokensUsed,
        completionTokensUsed,
        steps: stoppedAtStep,
        request,
        transcript,
        outOfBudget: true,
        stoppedBecause: 'budget',
        ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages, opts.budget.messageChars) } : {}),
        ...(checkpoints.length ? { checkpoints } : {}),
        ...(extensions.length ? { extensions } : {}),
        ...(unsupported.length ? { unsupported } : {}),
      };
    }
  }

  return {
    succeeded: false,
    ...(!circling && !thrashed && !stoppedTalking ? { outOfBudget: true } : {}),
    stoppedBecause: circling ? 'circling' : thrashed ? 'thrashing' : stoppedTalking ? 'silent' : 'budget',
    summary: circling
      ? `${circling} Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`
      : thrashed
      ? thrashSummary(unproductiveTurns, transcript)
      : stoppedTalking
      ? `Stopped calling tools after ${stoppedAtStep} step(s) of ${maxSteps} — it answered in prose `
        + `three turns running instead of acting, which usually means something it believed about the `
        + `environment was wrong. Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`
      : wrapUpProse
        ? `${exhausted === 'tokens'
            ? `Ran out of tokens (${tokensUsed.toLocaleString()} of ${maxTokens.toLocaleString()})`
            : `Ran out of steps (${maxSteps})`} without calling finish. Asked to account for itself, `
          + `it said: "${wrapUpProse}"`
      : exhausted === 'tokens'
        ? `Ran out of tokens (${tokensUsed.toLocaleString()} of ${maxTokens.toLocaleString()}) without calling finish. `
          + `Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`
        : `Ran out of steps (${maxSteps}) without calling finish. Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`,
    tokensUsed,
    completionTokensUsed,
    steps: stoppedAtStep,
    request,
    transcript,
    ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages, opts.budget.messageChars) } : {}),
    ...(checkpoints.length ? { checkpoints } : {}),
    ...(extensions.length ? { extensions } : {}),
    ...(unsupported.length ? { unsupported } : {}),
  };
}

function snapshotConversation(messages: Record<string, unknown>[], cap: number): ConversationMessage[] {
  return messages.map((m) => {
    const content = String(m.content ?? '');
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    return {
      role: m.role as ConversationMessage['role'],
      content: clipHead(content, cap),
      ...(calls.length
        ? {
            toolCalls: calls.map((c: any) => ({
              id: String(c?.id ?? ''),
              name: String(c?.function?.name ?? ''),
              arguments: clipHead(String(c?.function?.arguments ?? ''), cap),
            })),
          }
        : {}),
      ...(m.tool_call_id ? { toolCallId: String(m.tool_call_id) } : {}),
      ...(m.name ? { name: String(m.name) } : {}),
      ...(content.length > cap ? { truncated: true } : {}),
    };
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `…[${text.length - max} chars cut]\n${text.slice(-max)}`;
}

function clipHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[${text.length - max} chars cut]`;
}

async function runSandboxTool(
  sandbox: SandboxDriver,
  name: string,
  args: Record<string, unknown>,
  transcript: string[],
  web?: WebTools | undefined,
  saveMemory?: AgentRunOptions['saveMemory'],
  validationRecipe?: ValidationRecipe | undefined,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (name === 'validate_progress') {
    transcript.push('validate_progress');
    const validator = new UniversalValidatorService();
    const env = {
      exec: async (cmd: string) => sandbox.exec(cmd),
      readFile: async (p: string) => sandbox.readFile(p),
      fetch: fetchImpl ?? fetch,
    };

    let activeRecipe = validationRecipe;
    if (!activeRecipe || !activeRecipe.checks?.length) {
      activeRecipe = await validator.inferRecipe(env);
    }

    if (!activeRecipe || !activeRecipe.checks?.length) {
      return JSON.stringify({
        passed: true,
        message: 'No specific validation recipe configured for this leaf. Verify manually using test commands or artifact inspection.',
      });
    }

    const focusCheck = args.focusCheck ? String(args.focusCheck) : undefined;
    const summary = await validator.validate(activeRecipe, env, focusCheck);
    return JSON.stringify({
      passed: summary.passed,
      type: summary.type,
      totalChecks: summary.totalChecks,
      passedChecks: summary.passedChecks,
      failedChecks: summary.failedChecks,
      diagnosticReport: summary.diagnosticReport,
      checks: summary.checks,
    });
  }

  if (name === 'run_command') {
    const command = String(args.command ?? '');
    if (!command.trim()) return JSON.stringify({ error: 'command is required' });
    transcript.push(command);
    const r = await sandbox.exec(command);
    return JSON.stringify({
      exitCode: r.exitCode,
      ...(r.timedOut ? { timedOut: true, note: 'Command was killed for taking too long.' } : {}),
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }

  if (name === 'write_file') {
    let path = String(args.path ?? '');
    if (!path) return JSON.stringify({ error: 'path is required' });
    if (path.startsWith('/work/')) path = path.slice(6);
    else if (path.startsWith('work/')) path = path.slice(5);
    const content = typeof args.content === 'object' && args.content !== null
      ? JSON.stringify(args.content, null, 2)
      : String(args.content ?? '');
    await sandbox.writeFile(path, content);
    transcript.push(`write ${path}`);
    return JSON.stringify({ written: path, bytes: content.length });
  }

  if (name === 'read_file') {
    let path = String(args.path ?? '');
    if (!path) return JSON.stringify({ error: 'path is required' });
    if (path.startsWith('/work/')) path = path.slice(6);
    else if (path.startsWith('work/')) path = path.slice(5);
    transcript.push(`read ${path}`);
    return JSON.stringify({ path, content: await sandbox.readFile(path) });
  }

  if (name === 'save_harness_memory') {
    const title = String(args.title ?? '').trim();
    const text = String(args.text ?? '').trim();
    const category = String(args.category ?? 'lessons_learned');
    if (!title || !text) return JSON.stringify({ error: 'title and text are required' });
    transcript.push(`memory: ${title}`);

    if (!saveMemory) {
      return JSON.stringify({
        saved: false,
        error: 'Memory cannot be saved in this run — nothing is listening. Say it in your finish summary instead.',
      });
    }

    const suggestedScope = args.suggestedScope === 'global' ? 'global' : 'project';
    let action = 'ADD';
    try {
      ({ action } = await saveMemory({ category, title, text, suggestedScope }));
    } catch (err: any) {
      return JSON.stringify({ saved: false, error: `Could not save that: ${String(err?.message ?? err).slice(0, 200)}` });
    }

    const noted = action === 'NOOP'
      ? 'Not stored — the memory bank already holds this. Nothing more to do.'
      : 'Stored. It will be available to future runs on this project.';

    return JSON.stringify({ saved: action !== 'NOOP', action, category, title, suggestedScope, note: noted });
  }

  if (name === 'inspect_git_diff') {
    transcript.push('inspect_git_diff');
    await sandbox.exec('git init 2>/dev/null || true');
    await sandbox.exec('git config user.email koala@test 2>/dev/null || true');
    await sandbox.exec('git config user.name Koala 2>/dev/null || true');
    await sandbox.exec('git add -N . 2>/dev/null || true');
    const r = await sandbox.exec('git diff HEAD || git diff');
    return JSON.stringify({
      exitCode: r.exitCode,
      diff: r.stdout || r.stderr || 'No git diff changes found in repository.',
    });
  }

  if (name === 'test_http_endpoint') {
    const url = String(args.url ?? 'http://localhost:8080');
    const method = String(args.method ?? 'GET');
    transcript.push(`http ${method} ${url}`);
    const r = await sandbox.exec(`curl -s -i -X ${method} "${url}"`);
    return JSON.stringify({
      exitCode: r.exitCode,
      response: r.stdout || r.stderr,
    });
  }

  if (name === 'run_linter_audit') {
    const path = String(args.path ?? '.');
    transcript.push(`linter ${path}`);
    const r = await sandbox.exec(`npx eslint "${path}" || true`);
    return JSON.stringify({
      exitCode: r.exitCode,
      output: r.stdout || r.stderr || 'Linter audit complete.',
    });
  }

  if (name === 'query_in_memory_db') {
    const query = typeof args.query === 'object' && args.query !== null
      ? JSON.stringify(args.query)
      : String(args.query ?? '');
    transcript.push(`db_query ${query}`);
    const r = await sandbox.exec(`node -e 'try { const d=require("./db.json"); console.log(JSON.stringify(d)); } catch(e) { console.log("[]"); }'`);
    return JSON.stringify({
      exitCode: r.exitCode,
      result: r.stdout,
    });
  }

  if (name === 'run_tests') {
    const command = String(args.command ?? 'npm test');
    transcript.push(`run_tests: ${command}`);
    const r = await sandbox.exec(command);
    return JSON.stringify({
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }

  if (name === 'web_search' || name === 'fetch_web_page') {
    if (!web) {
      return JSON.stringify({ error: 'No web tools are available to this run. Do not try curl or wget — this sandbox has no network access.' });
    }
    if (name === 'web_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query parameter is required' });
      transcript.push(`web_search: ${query}`);
      try {
        const outcome = await web.search(query);

        return JSON.stringify(renderSearchOutcome(query, outcome));
      } catch (err: any) {
        return JSON.stringify({
          query,
          unavailable: true,
          error: `Search failed: ${err?.message || err}`,
          note: 'This says nothing about whether results exist. Rephrasing will not help.',
        });
      }
    }
    const url = String(args.url ?? '').trim();
    if (!url) return JSON.stringify({ error: 'url parameter is required' });
    transcript.push(`fetch_web_page: ${url}`);
    try {
      return JSON.stringify({ url, content: await web.fetchPage(url) });
    } catch (err: any) {
      return JSON.stringify({ url, content: `Failed to fetch page: ${err?.message || err}` });
    }
  }

  return JSON.stringify({ error: `Unknown tool ${name}` });
}

export async function readStreamedReply(
  response: { body?: any; text?: () => Promise<string> },
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  tokens: number;
  finishReason: string;
  completionTokens: number;
}> {
  const scanner = new ToolCallScanner();
  const rawSink: string[] = [];
  let content = '';
  let reasoning = '';
  let tokens = 0;
  let finishReason = '';
  let completionTokens = 0;
  let buffer = '';

  const consume = (chunk: string) => {
    if (process.env.KOALA_DEBUG_RAW) rawSink.push(chunk);
    scanner.push(chunk);
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const frame = JSON.parse(payload);
        const delta = frame?.choices?.[0]?.delta;
        content += delta?.content ?? '';
        reasoning += delta?.reasoning_content ?? '';
        if (frame?.usage?.total_tokens) tokens = Number(frame.usage.total_tokens);
        if (frame?.usage?.completion_tokens) completionTokens = Number(frame.usage.completion_tokens);
        if (frame?.choices?.[0]?.finish_reason) finishReason = String(frame.choices[0].finish_reason);
      } catch { /* ignored */ }
    }
  };

  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
  } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) consume(chunk.toString());
  } else if (typeof response.text === 'function') {
    consume(await response.text());
  }

  const calls = scanner.result();
  if (process.env.KOALA_DEBUG_RAW && !calls.length) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.KOALA_DEBUG_RAW, `\n===== TURN WITH NO TOOL CALL =====\n${rawSink.join('')}\n`);
  }
  return { content, reasoning, toolCalls: calls, tokens, finishReason, completionTokens };
}
