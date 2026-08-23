/**
 * One planning turn, headless — the decomposition cycle, runnable without a browser.
 *
 * ── WHY THIS EXISTS ──
 * There are two loops. The execution cycle (`runAgentLoop`) works in a sandbox with
 * `run_command`/`write_file`/`finish`; the planning cycle answers a request by calling
 * `propose_leaf` and friends. The Lab could only drive the first, so the very first experiment
 * written against planning asked the model to plan and then checked a sandbox for a file the
 * sandbox loop has no tool to produce. It scored 0/9 and the number meant nothing.
 *
 * ── WHAT IS SHARED, AND WHAT IS NOT ──
 * Shared with `/api/chat`, deliberately, because measuring a reimplementation is how that first
 * null result happened:
 *   · `buildOutboundMessages` — one system message, first, assembled the same way
 *   · `LEAF_TOOLS` — the same tool schemas
 *   · `runLeafTool` — the same execution, which is where proposals are actually created
 *   · `resolveConfig` / `conversationSampling` — the same precedence and the same samplers
 *
 * NOT shared, and named here rather than left to be assumed: streaming, the reasoning monitor and
 * its abort path, auto-continuation on `finish_reason: length`, and the stage-2 prose pass. Those
 * exist to make a conversation feel right to a human watching it. An experiment has no human
 * watching and no client to stream to, and a monitor that aborts generation would silently change
 * what is being measured.
 */
import { buildOutboundMessages, type OutboundMessage } from './leaf-context.js';
import { LEAF_TOOLS, ToolCallScanner } from './leaf-tools.js';
import { PLAN_SYSTEM_PROMPT } from './plan-mode.js';
import { estimatePromptComplexity } from './smart-token-controller.js';
import { TOOL_DISCIPLINE_PROMPT } from './sampling.js';
import { runLeafTool, type LeafToolContext } from './leaf-tool-runner.js';
import { runResearchAgent, type ResearchFinding } from './research-agent.js';
import { serialiseBoard } from './planning-board.js';
import { buildModelRequest } from './model-request.js';
import { resolveConfig, type Persona } from './personas.js';
import type { HarnessProfile } from './harness-profile.js';
import type { Leaf } from './leaves.js';
import type { ModelKind } from '@koala/harness-types';
import type { WebSearchFn } from './web-tools.js';

/**
 * The planner's tools: the leaf tools, minus live search, plus a way to ask for findings.
 *
 * Search is removed rather than stubbed. A tool that is offered and silently returns nothing makes
 * the model conclude there is no information and plan around that — an artifact of the stub, not
 * of the planner. If a capability is absent the model has to be told.
 */
export const PLANNER_TOOLS = [
  ...LEAF_TOOLS.filter((t) => !['web_search', 'fetch_web_page'].includes(t.function.name)),
  {
    type: 'function' as const,
    function: {
      name: 'research',
      description:
        'You have NO web access. Ask for findings on specific questions and they will be researched '
        + 'and returned to you. Break what you need to know into separate, answerable questions — '
        + 'ask only what you genuinely cannot decompose the work without, and use what comes back '
        + 'rather than asking again.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: 'One or more specific questions. Not topics — questions with answers.',
          },
        },
        required: ['questions'],
      },
    },
  },
];

/**
 * Why the loop stopped.
 *
 * Recorded rather than inferred, because "stopped because it had what it needed" and "stopped
 * because it hit a ceiling" are different facts about the run and only one of them is good. The
 * same distinction as `incomplete` versus `wrong` on an execution run, and for the same reason: a
 * boolean hides the case where the answer might have been fine given one more round.
 */
export type PlanningExit =
  /** Asked for no more research and stopped calling tools. The only clean exit. */
  | 'satisfied'
  /** Asked something it had already asked — going in circles rather than being thorough. */
  | 'repeating'
  /** Findings stopped changing the board, so more of them will not help. */
  | 'converged'
  /** Hit the round ceiling. The plan may simply be unfinished — not a pass. */
  | 'capped';

/** Rounds a planning turn gets, research included. Higher than a chat turn: research costs rounds. */
export const MAX_PLANNING_ROUNDS = 8;

/** One tool call the model made, kept so a run can be read afterwards. */
export interface PlanningToolCall {
  name: string;
  arguments: string;
  result: string;
}

export interface PlanningTurn {
  /** The prose the model produced, after any tool rounds. */
  reply: string;
  /** Every tool call it made, in order — the record of HOW it decomposed, not just what it left. */
  toolCalls: PlanningToolCall[];
  /** Leaves on the branch when the turn ended. The output being measured. */
  leaves: Leaf[];
  /** Rounds of tool calling used. Hitting the cap means it never stopped to answer. */
  rounds: number;
  tokensUsed: number;
  /** Why the loop stopped. `satisfied` is the only one that is not also a finding. */
  exit: PlanningExit;
  /** Every question it asked and what came back — the record of what it did not already know. */
  research: ResearchFinding[];
  /** Exactly what the model was asked, so a score has its input beside it. */
  request: { systemPrompt: string; parameters: Record<string, unknown>; tools: string[] };
}

export interface PlanningTurnOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string | undefined;
  kind?: ModelKind | undefined;
  /** The request being decomposed. */
  prompt: string;
  /** Everything the tools need, including which branch the leaves land on. */
  tools: LeafToolContext;
  profile?: HarnessProfile | null;
  persona?: Persona | null;
  /** Per-run overrides, sitting where a chat request's own parameters do. */
  overrides?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
  /**
   * How the planner's research questions get answered. Absent means research is unavailable, and
   * the planner is told so rather than handed a tool that returns nothing.
   */
  research?: {
    webSearch: WebSearchFn;
    fetchWebPage: (url: string) => Promise<string>;
  } | undefined;
}

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export async function runPlanningTurn(opts: PlanningTurnOptions): Promise<PlanningTurn> {
  const doFetch = opts.fetchImpl ?? fetch;
  const resolved = resolveConfig(opts.profile ?? null, opts.persona ?? null, opts.overrides ?? {});

  /**
   * Always the explicit plan prompt.
   *
   * Chat decides between plan and ambient from a mode and a complexity tier, which is right for a
   * conversation where most turns are not planning. An experiment that asked for a decomposition
   * and then let a heuristic decide whether to request one would be measuring the heuristic.
   */
  const messages = buildOutboundMessages({
    messages: [{ role: 'user', content: opts.prompt }],
    lastIndex: 0,
    prompt: PLAN_SYSTEM_PROMPT,
    toolPrompt: TOOL_DISCIPLINE_PROMPT,
    leaves: [],
    ...(resolved.systemPrompt ? { personaPrompt: resolved.systemPrompt } : {}),
  });

  /**
   * Built through the shared builder, which owns both the precedence and the placement.
   *
   * This used to spread `conversationSampling` LAST — undoing the resolved chain for every key it
   * sets — and filtered overrides by hand, which sent `think` as a top-level field the engine
   * ignores instead of nesting it under `template_vars`.
   */
  const strategy = estimatePromptComplexity([{ role: 'user', content: opts.prompt }], 'plan', true);
  const built = buildModelRequest({
    turn: 'conversation',
    ...(opts.kind ? { kind: opts.kind } : {}),
    messages: [],
    stream: true,
    maxTokens: strategy.maxTokens,
    reasoningEffort: strategy.reasoningEffort,
    ...(opts.model ? { model: opts.model } : {}),
    overrides: resolved.overrides,
  });
  // Everything but the per-round parts, which the loop supplies each time.
  const { messages: _messages, stream: _stream, ...parameters } = built.body;

  const conversation: OutboundMessage[] = [...messages];
  const toolCalls: PlanningToolCall[] = [];
  const research: ResearchFinding[] = [];
  /** Normalised, so "What is the rate limit?" and "what is the rate limit" are the same question. */
  const asked = new Set<string>();
  let reply = '';
  let tokensUsed = 0;
  let rounds = 0;
  let exit: PlanningExit = 'capped';

  const boardNow = async () => {
    const current = (await opts.tools.db.getLeaves())
      .filter((l) => l.ownerId === opts.tools.userId && l.branchId === opts.tools.branchId);
    return JSON.stringify(serialiseBoard(current));
  };

  for (; rounds < MAX_PLANNING_ROUNDS; rounds++) {
    /**
     * STREAMED, even though nothing is watching.
     *
     * Measured against the live endpoint: with `stream: false` this model returns zero tool calls
     * in every configuration tried — plan prompt, terse prompt, no prompt, reasoning on and off,
     * even `tool_choice: required`. The same request with `stream: true` calls tools immediately.
     * TabbyAPI's tool-format parsing only runs on the streaming path, so a non-streaming planner
     * silently produces prose and no proposals — which is exactly what the first smoke run did.
     *
     * The response is consumed here rather than relayed. `ToolCallScanner` is the same parser the
     * chat route uses, so calls are assembled from deltas identically.
     */
    const response = await doFetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...parameters, messages: conversation, tools: PLANNER_TOOLS,
        stream: true, stream_options: { include_usage: true },
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Planning call failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }

    const raw = await response.text();
    const scanner = new ToolCallScanner();
    scanner.push(raw);

    let content = '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const chunk = trimmed.slice(5).trim();
      if (!chunk || chunk === '[DONE]') continue;
      try {
        const frame = JSON.parse(chunk) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { total_tokens?: number };
        };
        const delta = frame.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') content += delta;
        if (frame.usage?.total_tokens) tokensUsed = frame.usage.total_tokens;
      } catch {
        // Partial frames are normal mid-stream.
      }
    }

    // Kept rather than overwritten: a model that speaks across two rounds has said both things.
    if (content) reply = reply ? `${reply}\n${content}` : content;

    const calls: WireToolCall[] = scanner.result()
      .map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } }));
    if (!calls.length) {
      // Stopped calling tools of its own accord: it has what it needs.
      exit = 'satisfied';
      break;
    }

    conversation.push({
      role: 'assistant',
      content: '',
      tool_calls: calls.map((c, i) => ({
        id: c.id ?? `call_${rounds}_${i}`,
        type: 'function',
        function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
      })),
    });

    let repeated = false;
    let researched = false;
    const boardBefore = await boardNow();

    for (const [i, c] of calls.entries()) {
      const name = c.function?.name ?? '';
      const args = c.function?.arguments ?? '{}';
      let result: string;

      if (name === 'research') {
        researched = true;
        result = await answerResearch(args);
      } else {
        result = await runLeafTool(opts.tools, { name, arguments: args });
      }

      toolCalls.push({ name, arguments: args, result });
      conversation.push({
        role: 'tool',
        tool_call_id: c.id ?? `call_${rounds}_${i}`,
        name,
        content: result,
      });
    }

    /**
     * Two exits that only make sense after findings came back.
     *
     * `repeating` fires when it asks something it already asked — it has failed to use an answer
     * it was given, which is indistinguishable from thoroughness without this check. `converged`
     * fires when research did not change the board, because more of it will not either.
     */
    if (repeated) { exit = 'repeating'; break; }
    if (researched && (await boardNow()) === boardBefore && rounds > 0) { exit = 'converged'; break; }

    // Declared inside the loop body so the closure reads this round's flags.
    // eslint-disable-next-line no-inner-declarations
    async function answerResearch(raw: string): Promise<string> {
      if (!opts.research) {
        return JSON.stringify({ error: 'Research is unavailable on this run. Plan with what you know.' });
      }
      let questions: string[] = [];
      try {
        const parsed = JSON.parse(raw) as { questions?: unknown };
        questions = Array.isArray(parsed.questions) ? parsed.questions.map(String) : [];
      } catch { questions = []; }
      if (!questions.length) return JSON.stringify({ error: 'Give one or more specific questions.' });

      const answers: ResearchFinding[] = [];
      for (const question of questions) {
        const key = question.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
        if (asked.has(key)) {
          repeated = true;
          const earlier = research.find((r) => r.question.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '') === key);
          answers.push(earlier ?? { question, findings: '', sources: [], rounds: 0, tokensUsed: 0 });
          continue;
        }
        asked.add(key);
        const finding = await runResearchAgent({
          question,
          baseUrl: opts.baseUrl,
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.kind ? { kind: opts.kind } : {}),
          // The planner's own resolved config, so the sub-agent it spawns runs under the same
          // profile and persona rather than under the shipped defaults.
          ...(resolved.overrides ? { overrides: resolved.overrides } : {}),
          webSearch: opts.research.webSearch,
          fetchWebPage: opts.research.fetchWebPage,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        research.push(finding);
        answers.push(finding);
        tokensUsed += finding.tokensUsed;
      }
      return JSON.stringify({
        findings: answers.map((a) => ({ question: a.question, answer: a.findings, sources: a.sources })),
      });
    }
  }

  const leaves = (await opts.tools.db.getLeaves())
    .filter((l) => l.ownerId === opts.tools.userId && l.branchId === opts.tools.branchId);

  return {
    reply,
    toolCalls,
    leaves,
    rounds,
    tokensUsed,
    exit,
    research,
    request: {
      systemPrompt: String(messages[0]?.role === 'system' ? messages[0].content : ''),
      // No messages and no tool schemas: the record is about configuration, and the prompt is
      // already here in full.
      parameters,
      tools: PLANNER_TOOLS.map((t) => t.function.name),
    },
  };
}
