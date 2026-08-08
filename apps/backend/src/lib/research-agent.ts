/**
 * A sub-agent that answers one question with the web, so the planner does not have to.
 *
 * ── WHY THE PLANNER DOES NOT SEARCH ──
 * Giving the planning turn live search makes the same task give different answers on different
 * days, so repeats stop being comparable and a benchmark grows a network dependency mid-run. Taking
 * search away entirely measures a crippled planner — the real one has it, and whether it looks
 * something up before decomposing is exactly the behaviour worth measuring.
 *
 * So research becomes work that gets decomposed like any other: the planner names what it needs to
 * know, this answers it, and the findings come back as a tool result. The planning turn stays
 * offline and reproducible; the information still arrives.
 *
 * ── THE FIRST VERSION WAS WORSE THAN EITHER ──
 * Search was stubbed to return nothing while still being OFFERED. The model called it, got an empty
 * result, concluded there was no information, and planned around that — an artifact of the stub
 * rather than anything about the planner. If a capability is absent the model must be told, not
 * handed a tool that silently fails.
 */
import type { ModelKind } from '@koala/harness-types';
import { ToolCallScanner } from './leaf-tools.js';
import { buildModelRequest } from './model-request.js';

/** Findings for one question, with what they were drawn from. */
export interface ResearchFinding {
  question: string;
  /** Prose the planner can act on. Empty when nothing was found — which is itself an answer. */
  findings: string;
  /** URLs consulted, so a plan built on bad information can be traced to it. */
  sources: string[];
  rounds: number;
  tokensUsed: number;
}

/** How many search/fetch rounds one question gets before it has to answer with what it has. */
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
  webSearch: (query: string) => Promise<{ title: string; snippet: string; url: string }[]>;
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
      /**
       * A dispatch turn: its only useful output is a tool call, so it gets the tool-turn profile —
       * no repetition penalties, which eliminate tool calling on this harness.
       *
       * Reasoning off through the registry rather than by writing `template_vars` here: the knob
       * knows where it belongs, and hand-written placement is what sent `think` to a field the
       * engine ignores elsewhere.
       */
      body: JSON.stringify(buildModelRequest({
        turn: 'tool-turn',
        ...(opts.kind ? { kind: opts.kind } : {}),
        messages,
        tools: RESEARCH_TOOLS,
        stream: true,
        maxTokens: 1500,
        ...(opts.model ? { model: opts.model } : {}),
        overrides: { think: false },
        extra: { stream_options: { include_usage: true } },
      }).body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // A failed search is not a failed plan. The planner gets "I could not find out", which is a
    // usable answer, rather than the whole run dying on a rate limit.
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
      } catch {
        // Partial frames are normal mid-stream.
      }
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
          const hits = await opts.webSearch(String(args.query ?? ''));
          for (const h of hits) sources.push(h.url);
          result = JSON.stringify({ results: hits });
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
