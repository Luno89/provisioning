import { buildOutboundMessages, type OutboundMessage } from './leaf-context.js';
import { ToolCallScanner } from './leaf-tools.js';
import { PLAN_SYSTEM_PROMPT } from './plan-mode.js';
import { estimatePromptComplexity } from './smart-token-controller.js';
import { TOOL_DISCIPLINE_PROMPT } from './sampling.js';
import { forSurface } from './tool-catalogue.js';
import type { ToolRepositoryItem } from './tool-seeds.js';
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
 * The planner's toolset: the planning surface without the web tools, plus `research`.
 *
 * A function over rows rather than a constant, so it reflects the catalogue the caller's user
 * actually has. `LEAF_TOOLS` was a second declaration of the same set.
 */
export const plannerTools = (rows: readonly ToolRepositoryItem[]) => [
  ...forSurface(rows, 'planning').filter((t) => !['web_search', 'fetch_web_page'].includes(t.function.name)),
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

export type PlanningExit =
  | 'satisfied'
  | 'repeating'
  | 'converged'
  | 'capped';

export const MAX_PLANNING_ROUNDS = 8;

export interface PlanningToolCall {
  name: string;
  arguments: string;
  result: string;
}

export interface PlanningTurn {
  reply: string;
  toolCalls: PlanningToolCall[];
  leaves: Leaf[];
  rounds: number;
  tokensUsed: number;
  exit: PlanningExit;
  research: ResearchFinding[];
  request: { systemPrompt: string; parameters: Record<string, unknown>; tools: string[] };
}

export interface PlanningTurnOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string | undefined;
  kind?: ModelKind | undefined;
  prompt: string;
  tools: LeafToolContext;
  profile?: HarnessProfile | null;
  persona?: Persona | null;
  pack?: { overrides?: Record<string, unknown> } | null;
  /** The caller's tool catalogue. Rows, because the planner's set is a view of it. */
  toolRows?: readonly ToolRepositoryItem[];
  overrides?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
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
  const resolved = resolveConfig(opts.profile ?? null, opts.pack ?? null, opts.overrides ?? {}, opts.persona ?? null);

  const messages = buildOutboundMessages({
    messages: [{ role: 'user', content: opts.prompt }],
    lastIndex: 0,
    prompt: PLAN_SYSTEM_PROMPT,
    toolPrompt: TOOL_DISCIPLINE_PROMPT,
    leaves: [],
    ...(resolved.systemPrompt ? { personaPrompt: resolved.systemPrompt } : {}),
  });

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
  const { messages: _messages, stream: _stream, ...parameters } = built.body;

  const conversation: OutboundMessage[] = [...messages];
  const toolCalls: PlanningToolCall[] = [];
  const research: ResearchFinding[] = [];
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
    const response = await doFetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...parameters, messages: conversation, tools: plannerTools(opts.toolRows ?? []),
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
      } catch { /* ignored */ }
    }

    if (content) reply = reply ? `${reply}\n${content}` : content;

    const calls: WireToolCall[] = scanner.result()
      .map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } }));
    if (!calls.length) {
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

    if (repeated) { exit = 'repeating'; break; }
    if (researched && (await boardNow()) === boardBefore && rounds > 0) { exit = 'converged'; break; }

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
      parameters,
      tools: plannerTools(opts.toolRows ?? []).map((t) => t.function.name),
    },
  };
}
