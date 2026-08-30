import type { ModelKind } from '@koala/harness-types';
import { ToolCallScanner } from './leaf-tools.js';
import { buildModelRequest } from './model-request.js';
import { renderSearchOutcome, type WebSearchFn } from './web-tools.js';
import type { SamplingConfig } from '@koala/harness-types';

export interface ResearchFinding {
  question: string;
  findings: string;
  sources: string[];
  rounds: number;
  tokensUsed: number;
}

export const MAX_RESEARCH_ROUNDS = 3;

const RESEARCH_PROMPT = [
  'You answer ONE question using web search, for a planner that has no web access itself.',
  '',
  'Search, read what you find, and then answer in plain prose. Be concrete: names, versions,',
  'endpoints, constraints. Say plainly when you could not find something — a planner acting on a',
  'guess you presented as fact is worse off than one told the answer is unknown.',
  '',
  'Do not plan the work. Do not suggest tasks. Answer the question and stop.',
].join('\n');

const RESEARCH_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the live web for current information, documentation, or versions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_web_page',
      description: 'Fetch one page in full, for when a search snippet is not enough.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The page to fetch.' } },
        required: ['url'],
      },
    },
  },
];

export interface ResearchOptions {
  question: string;
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string | undefined;
  kind?: ModelKind | undefined;
  sampling?: SamplingConfig | undefined;
  webSearch: WebSearchFn;
  fetchWebPage: (url: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
}

export async function runResearchAgent(opts: ResearchOptions): Promise<ResearchFinding> {
  const doFetch = opts.fetchImpl ?? fetch;
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: RESEARCH_PROMPT },
    { role: 'user', content: opts.question },
  ];

  const sources: string[] = [];
  let findings = '';
  let tokensUsed = 0;
  let rounds = 0;

  for (; rounds <= MAX_RESEARCH_ROUNDS; rounds++) {
    const response = await doFetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(buildModelRequest({
        turn: 'tool-turn',
        ...(opts.sampling ? { sampling: opts.sampling } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
        messages,
        tools: RESEARCH_TOOLS,
        stream: true,
        maxTokens: 1500,
        ...(opts.model ? { model: opts.model } : {}),
        think: false,
        extra: { stream_options: { include_usage: true } },
      }).body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok) {
      return { question: opts.question, findings: '', sources, rounds, tokensUsed };
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
        if (typeof frame.choices?.[0]?.delta?.content === 'string') content += frame.choices[0].delta.content;
        if (frame.usage?.total_tokens) tokensUsed += frame.usage.total_tokens;
      } catch { /* ignored */ }
    }
    if (content) findings = content;

    const calls = scanner.result().map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } }));
    if (!calls.length) break;

    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: calls.map((c, i) => ({
        id: c.id ?? `r${rounds}_${i}`,
        type: 'function',
        function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
      })),
    });

    for (const [i, c] of calls.entries()) {
      const name = c.function?.name ?? '';
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function?.arguments ?? '{}'); } catch { args = {}; }
      let result = '';
      try {
        if (name === 'web_search') {
          const outcome = await opts.webSearch(String(args.query ?? ''));
          for (const h of outcome.hits) sources.push(h.url);
          result = JSON.stringify(renderSearchOutcome(String(args.query ?? ''), outcome));
        } else if (name === 'fetch_web_page') {
          const url = String(args.url ?? '');
          sources.push(url);
          result = JSON.stringify({ url, content: (await opts.fetchWebPage(url)).slice(0, 6000) });
        } else {
          result = JSON.stringify({ error: `Unknown tool ${name}` });
        }
      } catch (err: any) {
        result = JSON.stringify({ error: String(err?.message ?? err).slice(0, 200) });
      }
      messages.push({ role: 'tool', tool_call_id: c.id ?? `r${rounds}_${i}`, name, content: result });
    }
  }

  return { question: opts.question, findings, sources: [...new Set(sources)], rounds, tokensUsed };
}
