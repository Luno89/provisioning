import { buildOutboundMessages, type OutboundMessage } from './leaf-context.js';
import { ToolCallScanner } from './leaf-tools.js';
import { describeWorkerSandbox } from './workspace-spec.js';
import { fittedMaxTokens } from './sampling.js';
import { schemasFor } from './tool-catalogue.js';
import type { ToolRepositoryItem } from './tool-seeds.js';
import { runTool, type LeafToolContext } from './tool-registry.js';
import { runResearchAgent, type ResearchFinding } from './research-agent.js';
import { serialiseBoard } from './planning-board.js';
import { buildModelRequest } from './model-request.js';
import { resolvePrompt, type Persona } from './personas.js';
import type { HarnessProfile } from './harness-profile.js';
import type { Leaf } from './leaves.js';
import type { ModelKind } from '@koala/harness-types';
import type { WebSearchFn } from './web-tools.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import type { BudgetConfig, PromptConfig, SamplingConfig } from '@koala/harness-types';

export const plannerTools = (
  rows: readonly ToolRepositoryItem[],
  granted?: readonly string[],
) => schemasFor(rows, granted ?? []);

export type PlanningExit =
  | 'satisfied'
  | 'repeating'
  | 'converged'
  | 'capped';

export const MAX_PLANNING_ROUNDS = 8;
const DEFAULT_PLAN_TOKENS = 8000;

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
  toolRows?: readonly ToolRepositoryItem[];
  images?: readonly WorkspaceImageSpec[];
  sampling?: SamplingConfig | undefined;
  promptConfig?: PromptConfig | undefined;
  budget?: BudgetConfig | undefined;
  grantedTools?: readonly string[] | undefined;
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
  const personaPrompt = resolvePrompt(opts.persona ?? null);

  const planPrompt = [
    opts.promptConfig?.sections.planning ?? '',
    describeWorkerSandbox(opts.images ?? []),
  ].filter(Boolean).join('\n\n');

  const messages = buildOutboundMessages({
    messages: [{ role: 'user', content: opts.prompt }],
    lastIndex: 0,
    prompt: planPrompt,
    toolPrompt: opts.promptConfig?.sections.toolDiscipline ?? '',
    leaves: [],
    ...(personaPrompt ? { personaPrompt } : {}),
  });

  const maxRounds = opts.budget?.rounds ?? MAX_PLANNING_ROUNDS;
  const built = buildModelRequest({
    turn: 'tool-turn',
    ...(opts.sampling ? { sampling: opts.sampling } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    messages: [],
    stream: true,
    maxTokens: opts.budget
      ? fittedMaxTokens(
          opts.budget,
          opts.budget.replyTokens.plan,
          messages.reduce((n, m) => n + String(m.content ?? '').length, 0),
        )
      : DEFAULT_PLAN_TOKENS,
    ...(opts.model ? { model: opts.model } : {}),
  });
  const { messages: _messages, stream: _stream, ...parameters } = built.body;

  const conversation: OutboundMessage[] = [...messages];
  const toolCalls: PlanningToolCall[] = [];
  const research: ResearchFinding[] = [];
  const asked = new Set<string>();
  let reply = '';
  let tokensUsed = 0;
  let rounds = 0;
  let repeated = false;
  let exit: PlanningExit = 'capped';

  const answerResearch = async (questions: string[]): Promise<ResearchFinding[]> => {
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
        ...(opts.sampling ? { sampling: opts.sampling } : {}),
        webSearch: opts.research!.webSearch,
        fetchWebPage: opts.research!.fetchWebPage,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      research.push(finding);
      answers.push(finding);
      tokensUsed += finding.tokensUsed;
    }
    return answers;
  };

  const runtime: LeafToolContext = {
    ...opts.tools,
    ...(opts.research ? { research: answerResearch } : {}),
  };

  const boardNow = async () => {
    const current = (await opts.tools.db.getLeaves())
      .filter((l) => l.ownerId === opts.tools.userId && l.branchId === opts.tools.branchId);
    return JSON.stringify(serialiseBoard(current));
  };

  for (; rounds < maxRounds; rounds++) {
    const response = await doFetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...parameters, messages: conversation, tools: plannerTools(opts.toolRows ?? [], opts.grantedTools),
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

    let researched = false;
    const boardBefore = await boardNow();

    for (const [i, c] of calls.entries()) {
      const name = c.function?.name ?? '';
      const args = c.function?.arguments ?? '{}';
      let result: string;

      if (name === 'research') researched = true;
      result = (await runTool(runtime, { name, arguments: args })).content;

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
      tools: plannerTools(opts.toolRows ?? [], opts.grantedTools).map((t) => t.function.name),
    },
  };
}
