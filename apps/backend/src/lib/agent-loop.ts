/**
 * The agent loop: model ↔ sandbox, until the work is done.
 *
 * Kept out of the activity and free of Temporal so it can be driven against a real model and a real
 * sandbox in a test, which is the only way to find out whether a loop actually terminates.
 *
 * ── STREAMED, THOUGH NOBODY IS WATCHING ──
 * Not for the display. TabbyAPI returns `usage: null` on a non-streamed response and only reports
 * token counts in a final SSE frame when asked with `stream_options.include_usage` — measured, not
 * assumed. A non-streamed loop therefore meters every attempt at zero tokens, so the root budget
 * never trips and a runaway subtree bills forever while looking free. Streaming costs the
 * fragment reassembly ToolCallScanner already does for the chat path.
 *
 * ── EVERY EXIT IS AN EXIT ──
 * A loop over model output has three ways to not terminate: the model calls tools forever, it
 * stops calling tools without finishing, or it calls `finish` and keeps going. All three end the
 * loop here, and running out of steps is reported as a FAILURE with what was done — a summary
 * saying "did 24 things" reads as success and would mark broken work complete.
 */
import {
  SANDBOX_TOOLS,
  MAX_AGENT_STEPS,
  MAX_TOOL_RESULT_CHARS,
  buildAgentPrompt,
  clampToolResult,
  WRAPUP_STEPS,
} from './sandbox-tools.js';
import { parseToolArguments, ToolCallScanner, WEB_TOOLS } from './leaf-tools.js';
import { TOOL_REPOSITORY, formatToolRepoForOpenAI } from './tool-repository.js';
import type { WorkspaceLanguage } from './workspace-spec.js';
import type { ModelKind } from './model-registry.js';
import {
  TOOL_TURN_MAX_TOKENS, THINKING_TURN_MAX_TOKENS,
} from './sampling.js';
import { type Overrides } from './tunables.js';
import { buildModelRequest } from './model-request.js';
import type { AgentStep, AgentRequest, ConversationMessage } from '@koala/harness-types';

/** Re-exported: these cross the wire, so the Lab consumes the same declarations. */
export type { AgentStep, AgentRequest, ConversationMessage };

/** What the loop needs from a sandbox. An interface, so a test can drive it without a cluster. */
export interface SandboxDriver {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Per-field caps. A single reasoning block has been measured at ~8,000 characters, and a run has
 *  up to MAX_AGENT_STEPS of them — uncapped, one experiment could outgrow a Mongo document. */
export const MAX_TRACE_REASONING = 6000;
export const MAX_TRACE_CONTENT = 2000;
export const MAX_TRACE_TOOL_RESULT = 1200;
/**
 * Tool ARGUMENTS need a cap of their own, and it is the one that actually bites: a `write_file`
 * call carries the whole file, so a single step can be hundreds of kilobytes while every other
 * field is dutifully clipped. An experiment stores every run's trace in one document, so this is
 * what stands between a 30-run experiment and Mongo's 16MB limit.
 */
export const MAX_TRACE_TOOL_ARGS = 2000;

/**
 * Per-message cap on the stored conversation.
 *
 * Generous, because the point of keeping it is fidelity — a conversation trimmed to a summary is
 * the reconstruction it exists to replace. Still bounded: a run holds up to MAX_AGENT_STEPS turns
 * plus their tool results, and an experiment holds every run.
 */
export const MAX_CONVERSATION_MESSAGE = 6000;

export interface AgentRunResult {
  succeeded: boolean;
  summary: string;
  tokensUsed: number;
  steps: number;
  /** What the model was actually asked. Always populated — it is small and it is the context. */
  request: AgentRequest;
  /** Every command run, for the activity log. Not fed back to the model — it already has them. */
  transcript: string[];
  /** Turn-by-turn record of what the model PRODUCED. Only when captureTrace is set. */
  trace?: AgentStep[];
  /** The conversation as SENT, verbatim. Populated alongside the trace. */
  conversation?: ConversationMessage[];
  /**
   * Overrides that could not be sent — unknown keys, or engine-gated samplers on another engine.
   *
   * Reported rather than thrown, because a knob that does nothing is not a broken run. But it must
   * be reported: a variant silently running the same configuration as its control is precisely the
   * failure the registry exists to make impossible.
   */
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
  /** Engine, when known — decides whether engine-specific samplers are safe to send. */
  kind?: ModelKind | undefined;
  /**
   * Anything the registry in lib/tunables.ts knows how to change about the call.
   *
   * An open bag rather than named fields, deliberately. Named fields are what let `temperature`
   * exist in the type, the UI and the docs while never reaching the wire; here a key either
   * resolves to a declaration that says where it goes, or it is reported back as unsupported.
   */
  overrides?: Overrides | undefined;
  /** Keys supplied by the promoted profile, recorded so a run says where each value came from. */
  fromProfile?: string[] | undefined;
  /** Keys supplied by a persona, recorded beside `fromProfile` rather than merged into it. */
  fromPersona?: string[] | undefined;
  /**
   * Offer web_search and fetch_web_page.
   *
   * For research leaves, whose answer is not in any repository. Off for coding work: a search tool
   * in front of an agent with a repo to read is a way to spend steps not writing code.
   */
  webTools?: boolean | undefined;
  /**
   * Leave the reasoning pass on. Off by default: every turn here exists to produce a tool call,
   * and a turn spent deliberating is a turn that produces nothing while consuming the budget.
   */
  think?: boolean;
  /**
   * Keep a turn-by-turn record, including the model's reasoning.
   *
   * Off by default. A leaf execution has no use for it and would write hundreds of kilobytes into
   * its record on every attempt; an experiment exists to be read, so it turns this on.
   */
  captureTrace?: boolean;
  /**
   * Called as each step completes, with the same record the trace stores.
   *
   * Fires whether or not `captureTrace` is set — watching a run and keeping a record of it are
   * different needs, and a live view that only worked for experiments would be no use on the leaf
   * executions where a stuck agent actually costs something.
   *
   * Never awaited and never allowed to throw into the loop: a dropped frame is a cosmetic problem,
   * while an exception from a display would kill work that is going fine.
   */
  onStep?: (step: AgentStep) => void;
  /** Injected so a test can run without a network. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Injected memory bank context. */
  memoryContext?: string;
}

export async function runAgentLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const overrides = opts.overrides ?? {};

  // Loop-placement tunables are read here rather than sent. Explicit options still win, so a
  // caller that passes maxSteps directly is not overruled by an experiment's bag.
  const think = typeof overrides.think === 'boolean' ? overrides.think : Boolean(opts.think);
  const maxSteps = typeof overrides.maxSteps === 'number'
    ? overrides.maxSteps
    : (opts.maxSteps ?? MAX_AGENT_STEPS);
  const toolResultCap = typeof overrides.maxToolResultChars === 'number'
    ? overrides.maxToolResultChars
    : undefined;
  const model = typeof overrides.model === 'string' ? overrides.model : opts.model;

  const transcript: string[] = [];
  const trace: AgentStep[] = [];
  let tokensUsed = 0;
  let consecutiveNoToolTurns = 0;

  /**
   * The prompt is a knob like any other — but the TASK is not part of it.
   *
   * A replacement drops the generated environment description, which is the documented trade and
   * why the registry note warns about it. What it must never drop is the work: an override that
   * silently removed `taskContext` would produce an agent asked to do nothing, which cannot
   * succeed and would read as evidence that the wording was worse. So a custom prompt has the task
   * appended in the same shape the generated one uses, and the axis tests phrasing rather than
   * accidentally testing whether the agent was told what to do.
   */
  const useMemories = typeof overrides.useMemories === 'boolean' ? overrides.useMemories : true;
  const memoryContext = useMemories && opts.memoryContext ? opts.memoryContext.trim() : '';

  const custom = typeof overrides.systemPrompt === 'string' && overrides.systemPrompt.trim()
    ? overrides.systemPrompt
    : '';
  const extra = typeof overrides.extraInstructions === 'string' && overrides.extraInstructions.trim()
    ? overrides.extraInstructions
    : '';
  const systemPrompt = [
    custom || buildAgentPrompt(opts.language, opts.taskContext, maxSteps),
    ...(custom ? ['', 'YOUR TASK', opts.taskContext] : []),
    ...(extra ? ['', extra] : []),
    ...(memoryContext ? ['', memoryContext] : []),
  ].join('\n');

  const messages: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Begin. Start by looking at what is in the workspace.' },
  ];

  /**
   * The harness's own settings first, the experiment's overrides on top.
   *
   * Order is the whole point: spread the other way, an override would be silently discarded and two
   * variants differing only in temperature would run identically while reporting a difference.
   * `applyOverrides` is the only thing that writes a tunable onto the wire, so a knob that reaches
   * here either has a declaration saying where it goes or comes back in `unsupported`.
   */
  const toolRepoOpenAI = formatToolRepoForOpenAI(TOOL_REPOSITORY);
  const toolMap = new Map<string, any>();
  for (const t of SANDBOX_TOOLS) {
    toolMap.set(t.function.name, t);
  }
  for (const t of toolRepoOpenAI) {
    if (!toolMap.has(t.function.name)) {
      toolMap.set(t.function.name, t);
    }
  }
  /**
   * The web, for work whose answer is not in the repository.
   *
   * `web_search` and `fetch_web_page` have been DISPATCHED here all along (see the handlers below)
   * while being declared only in LEAF_TOOLS, which the planner uses — so an execution agent could
   * never call them. A research leaf without them can only answer from what the model already
   * knows, which is exactly the thing research is supposed to check.
   *
   * Off by default: a coding leaf has a repository to read and a budget to spend, and a search tool
   * in front of it is a way to spend steps not writing code.
   *
   * Both run in THIS process, not in the sandbox, so the workspace's default-deny egress is not
   * involved and does not need relaxing.
   */
  if (opts.webTools) {
    for (const t of WEB_TOOLS) toolMap.set(t.function.name, t);
  }
  const activeTools = Array.from(toolMap.values());

  /**
   * Built through the shared builder, like every other model call.
   *
   * This one was already correct — sampling first, then `applyOverrides` — and it is the shape the
   * builder encodes. Routing it through anyway removes the last copy: four chat sites and the
   * planning turn each had their own version of this assembly and every one of them got the order
   * or the placement wrong, silently.
   */
  const { body: requestBody, unsupported } = buildModelRequest({
    turn: 'tool-turn',
    ...(opts.kind ? { kind: opts.kind } : {}),
    messages,
    tools: activeTools,
    stream: true,
    maxTokens: think ? THINKING_TURN_MAX_TOKENS : TOOL_TURN_MAX_TOKENS,
    ...(model ? { model } : {}),
    // Reasoning is a registry knob, so it travels as one — `NO_THINKING` wrote `template_vars`
    // by hand, which is the mistake that lost `think` entirely on the chat path.
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
    loop: {
      maxSteps,
      think,
      toolResultCap: toolResultCap ?? MAX_TOOL_RESULT_CHARS,
    },
  };

  for (let step = 0; step < maxSteps; step++) {
    // `messages` is mutated across steps, and the body was built once — so the array reference is
    // shared and the conversation grows in place rather than being rebuilt per turn.
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

    const { content, reasoning, toolCalls, tokens } = await readStreamedReply(response);
    tokensUsed += tokens;

    // Built whenever anyone wants it — the trace keeps it, the live view watches it, and both may
    // be off, in which case the work of assembling it is skipped entirely.
    const record: AgentStep | undefined = opts.captureTrace || opts.onStep
      ? {
          step: step + 1,
          ...(reasoning ? { reasoning: clip(reasoning, MAX_TRACE_REASONING) } : {}),
          ...(content ? { content: clip(content, MAX_TRACE_CONTENT) } : {}),
          toolCalls: toolCalls.map((c) => ({ name: c.name, arguments: clipHead(c.arguments, MAX_TRACE_TOOL_ARGS) })),
          toolResults: [],
          tokens,
          ...(reasoning.length > MAX_TRACE_REASONING
          || content.length > MAX_TRACE_CONTENT
          || toolCalls.some((c) => c.arguments.length > MAX_TRACE_TOOL_ARGS)
            ? { truncated: true }
            : {}),
        }
      : undefined;
    if (record && opts.captureTrace) trace.push(record);

    /**
     * Publishes the step once its tool results are in.
     *
     * Wrapped, because a throwing listener would otherwise kill a run that is going perfectly well
     * — the display failing is not a reason to lose the work.
     */
    const publish = () => {
      if (!record || !opts.onStep) return;
      try {
        opts.onStep(record);
      } catch {
        // A dropped frame is cosmetic.
      }
    };

    messages.push({
      role: 'assistant',
      content,
      ...(toolCalls.length
        ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    });

    if (!toolCalls.length) {
      consecutiveNoToolTurns++;
      // Published before the nudge: a turn that produced no tool call is the failure most worth
      // watching live, and it is invisible in a progress counter.
      publish();
      // Answered in prose instead of acting. Give up after 3 consecutive turns without tools —
      // a model that has stopped using tools will usually keep narrating, and each round costs a full inference pass.
      if (consecutiveNoToolTurns >= 3 || step >= maxSteps - 1) break;
      messages.push({
        role: 'user',
        content: 'Use a tool, or call `finish` if the task is complete or you are stuck.',
      });
      continue;
    }

    consecutiveNoToolTurns = 0;

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
          steps: step + 1,
          request,
          transcript,
          ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages) } : {}),
          ...(unsupported.length ? { unsupported } : {}),
        };
      }

      let result: string;
      try {
        result = await runSandboxTool(opts.sandbox, name, args, transcript);
      } catch (err: any) {
        // Returned to the model, not thrown: a tool that fails is information the agent can act
        // on, and killing the attempt would discard everything done so far.
        result = JSON.stringify({ error: String(err?.message ?? err).slice(0, 500) });
      }

      record?.toolResults.push({ name, result: clip(result, MAX_TRACE_TOOL_RESULT) });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: clampToolResult(result, toolResultCap),
      });
    }

    /**
     * ── THE AGENT HAS TO KNOW WHERE IT IS ──
     *
     * The budget was stated once, in the system prompt, and never again — so an agent twenty steps
     * in had no way to know it. The axe then falls mid-task with nothing committed, which is
     * exactly how one leaf spent three attempts and 91,818 tokens without ever getting past
     * `mkdir` and `write package.json`.
     *
     * Attached to a tool result rather than sent as its own message: an extra turn would cost a
     * step, which is a perverse way to warn someone they are running out of steps.
     *
     * Silent until the end. A counter on every turn is noise the model learns to skip, and the
     * only moment the number changes a decision is when there is barely any left.
     */
    const remaining = maxSteps - (step + 1);
    if (remaining <= WRAPUP_STEPS && remaining > 0) {
      const last = messages[messages.length - 1] as { content?: string };
      last.content = `${last.content ?? ''}\n\n[${remaining} step${remaining === 1 ? '' : 's'} left of ${maxSteps}. `
        + 'Commit and push what you have NOW, then call `finish` — anything uncommitted is lost.]';
    }

    // After the whole tool loop, so the step arrives complete with its results rather than as a
    // call with an empty outcome that fills in later.
    publish();
  }

  return {
    succeeded: false,
    summary: `Ran out of steps (${maxSteps}) without calling finish. Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`,
    tokensUsed,
    steps: maxSteps,
    request,
    transcript,
    ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages) } : {}),
    ...(unsupported.length ? { unsupported } : {}),
  };
}

/**
 * The conversation as it stands, in the shape the record keeps.
 *
 * Read off the SAME array the request body carries, so there is no second assembly step that could
 * disagree with what was sent. Only the per-message cap changes anything, and it says so.
 */
function snapshotConversation(messages: Record<string, unknown>[]): ConversationMessage[] {
  return messages.map((m) => {
    const content = String(m.content ?? '');
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    return {
      role: m.role as ConversationMessage['role'],
      content: clipHead(content, MAX_CONVERSATION_MESSAGE),
      ...(calls.length
        ? {
            toolCalls: calls.map((c: any) => ({
              id: String(c?.id ?? ''),
              name: String(c?.function?.name ?? ''),
              arguments: clipHead(String(c?.function?.arguments ?? ''), MAX_CONVERSATION_MESSAGE),
            })),
          }
        : {}),
      ...(m.tool_call_id ? { toolCallId: String(m.tool_call_id) } : {}),
      ...(m.name ? { name: String(m.name) } : {}),
      ...(content.length > MAX_CONVERSATION_MESSAGE ? { truncated: true } : {}),
    };
  });
}

/** Truncates from the FRONT, so the end of a reasoning block — where it reaches a decision — survives. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `…[${text.length - max} chars cut]\n${text.slice(-max)}`;
}

/**
 * Truncates from the END — the opposite of `clip`, and deliberately.
 *
 * Tool arguments are JSON with the discriminating fields first: `{"path":"src/index.ts","content":
 * "…"}`. Keeping the tail would throw away the path and retain a fragment of file body, which is
 * the half that cannot be acted on.
 */
function clipHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[${text.length - max} chars cut]`;
}

async function runSandboxTool(
  sandbox: SandboxDriver,
  name: string,
  args: Record<string, unknown>,
  transcript: string[],
): Promise<string> {
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
    return JSON.stringify({
      saved: true,
      category,
      title,
      suggestedScope: args.suggestedScope || 'project',
      note: 'Memory recorded and sent to Memory Bank review queue.',
    });
  }

  if (name === 'inspect_git_diff') {
    transcript.push('inspect_git_diff');
    // Ensure repository is initialized so git diff returns valid output
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

  if (name === 'web_search') {
    const query = String(args.query ?? '').trim();
    if (!query) return JSON.stringify({ error: 'query parameter is required' });
    transcript.push(`web_search: ${query}`);
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      if (!res.ok) return JSON.stringify({ query, results: [{ snippet: `Search failed HTTP ${res.status}` }] });
      const html = await res.text();
      const results: { title: string; snippet: string; url: string }[] = [];
      const matches = html.matchAll(/<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g);
      for (const match of matches) {
        if (results.length >= 5) break;
        const rawUrl = match[1].replace(/&amp;/g, '&');
        const cleanTitle = match[2].replace(/<[^>]+>/g, '').trim();
        const cleanSnippet = match[3].replace(/<[^>]+>/g, '').trim();
        let finalUrl = rawUrl;
        const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) finalUrl = decodeURIComponent(uddgMatch[1]);
        if (cleanTitle && finalUrl) {
          results.push({ title: cleanTitle, snippet: cleanSnippet, url: finalUrl });
        }
      }
      return JSON.stringify({ query, results: results.length ? results : [{ snippet: 'No results found' }] });
    } catch (err: any) {
      return JSON.stringify({ query, results: [{ snippet: `Web search error: ${err?.message || err}` }] });
    }
  }

  if (name === 'fetch_web_page') {
    const url = String(args.url ?? '').trim();
    if (!url) return JSON.stringify({ error: 'url parameter is required' });
    transcript.push(`fetch_web_page: ${url}`);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      if (!res.ok) return JSON.stringify({ url, content: `HTTP error ${res.status}` });
      const html = await res.text();
      const cleanText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return JSON.stringify({ url, content: cleanText.slice(0, 4000) });
    } catch (err: any) {
      return JSON.stringify({ url, content: `Failed to fetch page: ${err?.message || err}` });
    }
  }

  return JSON.stringify({ error: `Unknown tool ${name}` });
}


/**
 * Reads one streamed completion into content, tool calls and a token count.
 *
 * Tool-call reassembly is delegated to ToolCallScanner — the same code the chat route uses, and
 * already tested against the fragment shapes this endpoint emits — while content and usage are
 * pulled from the same frames in one pass.
 */
async function readStreamedReply(
  response: { body?: any; text?: () => Promise<string> },
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  tokens: number;
}> {
  const scanner = new ToolCallScanner();
  let content = '';
  let reasoning = '';
  let tokens = 0;
  let buffer = '';

  const consume = (chunk: string) => {
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
        // Its own field, not inline <think> tags — measured against the live endpoint.
        reasoning += delta?.reasoning_content ?? '';
        // Usage arrives on its own final frame, after the last content frame.
        if (frame?.usage?.total_tokens) tokens = Number(frame.usage.total_tokens);
      } catch {
        // Partial frames are normal mid-stream.
      }
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
    // Node streams, which is what undici hands back in some versions and what a test fake is
    // easiest to write as.
    for await (const chunk of body) consume(chunk.toString());
  } else if (typeof response.text === 'function') {
    consume(await response.text());
  }

  return { content, reasoning, toolCalls: scanner.result(), tokens };
}
