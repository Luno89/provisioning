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
  conversationBudget,
  SANDBOX_TOOLS,
  MAX_AGENT_STEPS,
  MAX_AGENT_TOKENS,
  MAX_TOOL_RESULT_CHARS,
  buildAgentPrompt,
  clampToolResult,
  CODE_PACING,
  pacingNoteFor,
  trimConversation,
  toolsForStep,
  type PacingNote,
  type ToolWithdrawal,
} from './sandbox-tools.js';
import { parseToolArguments, ToolCallScanner, WEB_TOOLS } from './leaf-tools.js';
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
  TOOL_TURN_MAX_TOKENS, THINKING_TURN_MAX_TOKENS, turnMaxTokens, fittedMaxTokens,
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

/**
 * What the loop needs in order to save a checkpoint. Supplied by the activity; absent in tests.
 *
 * Returns the artifact TEXT, because the loop needs it for the reset prompt — the whole point is
 * that the conversation is replaced by this document. Returning undefined means the save did not
 * happen, and the loop then carries on WITHOUT resetting: discarding a context whose replacement
 * failed to write would lose the run.
 */
/**
 * Decides whether a run that hit a ceiling has earned more room.
 *
 * A callback for the same reason `checkpoint` is: answering it needs the repository, the deliverable
 * and the ROOT's remaining budget — a database read and a sandbox exec, neither of which belongs in
 * a loop that must stay drivable from a test. The loop contributes the one thing only it knows: its
 * own diagnoses of whether the run is thrashing, circling or gone quiet.
 *
 * Absent means budgets are hard ceilings, which is the behaviour every caller had before this.
 */
export type ExtendBudgetDriver = (input: {
  exhausted: 'steps' | 'tokens';
  extensionsUsed: number;
  step: number;
  tokensUsed: number;
  originalMaxSteps: number;
  originalMaxTokens: number;
  /** The loop's own diagnoses. Any one of them vetoes an extension — see decideExtension. */
  thrashing: boolean;
  circling: boolean;
  silent: boolean;
}) => Promise<{ steps?: number; tokens?: number; reason: string } | undefined>;

export type CheckpointDriver = (input: {
  /** 1-based, for the artifact's own heading. */
  number: number;
  /** The agent's account of itself, when the handoff turn produced one. */
  handoff?: Handoff | undefined;
  tokensUsed: number;
  maxTokens: number;
}) => Promise<{ artifact: string; sha?: string; branch?: string } | undefined>;

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
  /** Billed tokens — prompt plus completion, re-read every turn. What budgets enforce on. */
  tokensUsed: number;
  /**
   * Generated tokens only. Reported, never enforced.
   *
   * `readStreamedReply` has always returned this and the loop discarded it everywhere except the
   * truncation check. It is the difference between a leaf that thought hard and a leaf that read
   * its own context forty times, and those looked identical in the record.
   */
  completionTokensUsed: number;
  /**
   * Whether the run was stopped by its budget rather than ending on its own terms.
   *
   * Carried so the caller can tell a considered "I could not do this" from a wrap-up written under
   * duress — the summary reads the same either way, and the difference matters when deciding
   * whether another attempt is worth making.
   */
  outOfBudget?: boolean;
  /**
   * WHY the run stopped, as a value rather than as prose in the summary.
   *
   * ── WHAT THIS IS FOR ──
   * The three self-diagnoses below are conclusions the loop reached about itself: it is repeating,
   * it is producing nothing, it has stopped calling tools. A budget stop is not — it is the clock
   * running out on a run that might have been fine.
   *
   * That distinction decides whether a retry is worth anything. Measured across two projects: nine
   * leaves failed, and every one of them was diagnosed correctly on its FIRST attempt — "This is a
   * loop, not progress" — then retried twice more and looped again each time, identically. One
   * Synthesist recorded the same sentence three times. Roughly two thirds of the ~3.7M tokens those
   * projects spent on failures went into repeating a diagnosis that was already right.
   *
   * The summary said all of this in English. Nothing could act on it, because acting on it meant
   * parsing prose.
   */
  stoppedBecause?: 'circling' | 'thrashing' | 'silent' | 'budget';
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
   * Save points written during the run, in order.
   *
   * Worth surfacing because `conversation` is only the window since the LAST reset — by design, but
   * surprising if nothing says so. These are where the rest of it went.
   */
  checkpoints?: { step: number; tokensUsed: number; sha?: string; branch?: string }[];
  /**
   * Budget extensions granted, with the evidence that earned each one.
   *
   * Recorded because "this run took 300,000 tokens" and "this run took 300,000 tokens because its
   * tests went green twice on the way" are different facts, and only the second one is a reason.
   */
  extensions?: { step: number; at: 'steps' | 'tokens'; steps?: number; tokens?: number; reason: string }[];
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
  /**
   * The budget that corresponds to a cost.
   *
   * Steps bound patience; tokens bound spend. This is the one that should normally stop a run, and
   * hitting it goes through the same wrap-up as any other stop.
   */
  maxTokens?: number;
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
  /** Keys the PACK supplied — the runtime, as opposed to who ran. See `AgentRequest.fromPack`. */
  fromPack?: string[] | undefined;
  /**
   * Saves a mid-run checkpoint, if the caller can. Absent means the run simply does not checkpoint.
   *
   * Everything a checkpoint does that touches the world — reading the repository, writing the
   * artifact, committing, pushing, recording the branch — lives behind this, for the same reason
   * `sandbox` and `web` do: the loop stays free of Temporal and of Mongo, so it can be driven
   * against a real model in a test without either. The loop decides WHEN; this does HOW.
   */
  checkpoint?: CheckpointDriver | undefined;
  /** Grants more room to a run that is still producing. See ExtendBudgetDriver. */
  extendBudget?: ExtendBudgetDriver | undefined;
  /**
   * Persists a lesson the agent asked to record. Absent means the run cannot save memories.
   *
   * A callback because the loop has no database — the same reason `web` and `checkpoint` are. What
   * it must NOT do is write an active memory: see the tool's handler for why this queues.
   */
  saveMemory?: ((memory: {
    category: string;
    title: string;
    text: string;
    suggestedScope: 'project' | 'global';
    /**
     * What the harness did with it, so the tool's reply can be true.
     *
     * The writer runs the candidate past the most similar stored entries before keeping it
     * (lib/memory-decide.ts), so "saved" is no longer a foregone conclusion — it may have been
     * judged a duplicate. Reporting that back matters: an agent told its lesson is in effect will
     * reasonably stop repeating it.
     */
  }) => Promise<{ action: string }>) | undefined;
  /**
   * The web tools this run may use, already resolved to whatever is deployed.
   *
   * Passing them is what OFFERS them — there is no separate flag, because a flag that said "yes"
   * while no implementation was wired is exactly how the Lab ended up curling a sandbox with no
   * network. For research work, whose answer is not in any repository. Left out for coding work: a
   * search tool in front of an agent with a repo to read is a way to spend steps not writing code.
   */
  web?: WebTools | undefined;
  /**
   * The only tools this run may use, by name — normally a persona's saved list.
   *
   * Applied as an intersection with what the environment offers, so naming a tool that is not
   * available does not conjure it. This is what makes a persona's toolset a fact about the run
   * rather than a request: a persona that must not search is not asked politely to refrain, it is
   * never handed a search tool.
   */
  allowTools?: string[] | undefined;
  /**
   * Tools that are not the sandbox's — the MCP servers this harness has built and deployed.
   *
   * Offered alongside the built-ins and filtered by `allowTools` exactly like them, so a persona
   * that names its tools does not silently gain remote ones it never asked for.
   */
  remoteTools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] | undefined;
  /**
   * Runs a tool this loop does not own.
   *
   * Returns `undefined` for a name it does not recognise, so the sandbox still gets first refusal
   * and a built-in can never be shadowed by a remote one.
   */
  callRemote?: ((name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | undefined>) | undefined;
  /**
   * What to tell the agent as its budget runs down, and when.
   *
   * Supplied by the caller because it depends on how the work is SAVED. The default says "commit
   * and push", which a research leaf can neither do nor needs — it has no repository, and was being
   * told to preserve its answer somewhere that does not exist.
   */
  pacing?: PacingNote[] | undefined;
  /**
   * Tools to take away partway through, when telling the agent to stop using them does not work.
   *
   * See ToolWithdrawal — measured across four research runs, the model searched until its budget
   * was gone every time regardless of what it was told.
   */
  withdrawTools?: ToolWithdrawal | undefined;
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
  /**
   * What is mounted at `$SERVICE_BINDING_ROOT`, as `describeBindings` renders it.
   *
   * Passed in rather than derived, for the reason `service-binding.ts` gives: composing it keeps
   * one source of truth, where seeding it into each persona would go stale the moment a project's
   * dependencies changed.
   */
  bindingsContext?: string;
  /**
   * The sandbox as built, so the prompt can describe the real network rather than the default.
   *
   * Only the descriptive fields — this is for what the agent is TOLD, and the pod already exists by
   * the time the loop starts.
   */
  sandboxSpec?: Pick<WorkspaceSpec, 'egress' | 'env' | 'cpu' | 'memory'>;
  /**
   * The context window of the model THIS run resolved to.
   *
   * Per run rather than global: a persona names its own model, so a Researcher on a 131K engine and
   * a Judge on a smaller endpoint must not share a budget. Absent means nobody recorded one — a
   * registered endpoint — and the conservative fallback applies.
   */
  contextTokens?: number;
  /** Executable validation recipe / contract for this leaf. */
  validationRecipe?: ValidationRecipe | undefined;
}

/**
 * Names this loop owns.
 *
 * Read off SANDBOX_TOOLS rather than written out, so adding a built-in cannot leave a hole here
 * that a remote tool could occupy.
 */
const BUILT_IN_TOOL_NAMES = new Set(SANDBOX_TOOLS.map((t) => t.function.name));
const isBuiltInTool = (name: string) => BUILT_IN_TOOL_NAMES.has(name as never) || name === 'finish';

export async function runAgentLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const overrides = opts.overrides ?? {};

  // Loop-placement tunables are read here rather than sent. Explicit options still win, so a
  // caller that passes maxSteps directly is not overruled by an experiment's bag.
  const think = typeof overrides.think === 'boolean' ? overrides.think : Boolean(opts.think);
  /**
   * Mutable, because a producing run can earn more room — see lib/budget-extension.ts.
   *
   * The ORIGINALS are kept beside them so every grant is measured against what the persona actually
   * declared. Extending by a fraction of the CURRENT ceiling compounds, and a compounding runaway is
   * precisely what a budget exists to prevent.
   */
  let maxSteps = typeof overrides.maxSteps === 'number'
    ? overrides.maxSteps
    : (opts.maxSteps ?? MAX_AGENT_STEPS);
  let maxTokens = typeof overrides.maxTokens === 'number'
    ? overrides.maxTokens
    : (opts.maxTokens ?? MAX_AGENT_TOKENS);
  const originalMaxSteps = maxSteps;
  const originalMaxTokens = maxTokens;
  const toolResultCap = typeof overrides.maxToolResultChars === 'number'
    ? overrides.maxToolResultChars
    : undefined;
  const model = typeof overrides.model === 'string' ? overrides.model : opts.model;

  const transcript: string[] = [];
  const trace: AgentStep[] = [];
  let tokensUsed = 0;
  /** Generated tokens only — reported, never a ceiling. See AgentRunResult.completionTokensUsed. */
  let completionTokensUsed = 0;
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
    custom || buildAgentPrompt(opts.language, opts.taskContext, maxSteps, opts.sandboxSpec ?? {}),
    ...(custom ? ['', 'YOUR TASK', opts.taskContext] : []),
    ...(extra ? ['', extra] : []),
    /**
     * Outside the `custom` branch, like `memoryContext`, and for a stronger reason.
     *
     * This is a fact about the container the agent is standing in. A prompt override changes how it
     * is asked to work; it cannot change where its database lives. Dropping this on an override
     * would put an agent back to guessing connection strings — the failure that cost two projects
     * their budgets — and it would do so silently.
     */
    ...(opts.bindingsContext ? ['', opts.bindingsContext.trim()] : []),
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
  if (opts.web) {
    for (const t of WEB_TOOLS) toolMap.set(t.function.name, t);
  }
  /**
   * Intersected with the persona's declared list, when it has one.
   *
   * After the web tools are added, deliberately: a persona that declares web_search still only gets
   * it when `web` was supplied, and a persona that declares nothing still gets everything. Filtering
   * before this point would let the web tools slip back in underneath.
   */
  const offered = Array.from(toolMap.values());
  /**
   * Remote tools last, and never overwriting a built-in.
   *
   * `toolMap` is keyed by name, so adding these through it would let a remote tool replace
   * `run_command` or `finish` — a collision that does not error and instead has the model call one
   * thing and reach another.
   */
  for (const remote of opts.remoteTools ?? []) {
    if (!toolMap.has(remote.function.name)) offered.push(remote);
  }
  const activeTools = opts.allowTools?.length
    ? offered.filter((t) => opts.allowTools!.includes(t.function.name))
    : offered;

  /**
   * Built through the shared builder, like every other model call.
   *
   * This one was already correct — sampling first, then `applyOverrides` — and it is the shape the
   * builder encodes. Routing it through anyway removes the last copy: four chat sites and the
   * planning turn each had their own version of this assembly and every one of them got the order
   * or the placement wrong, silently.
   */
  const turnCap = turnMaxTokens({
    think,
    canWriteFiles: activeTools.some((t) => (t.function?.name || t.name) === 'write_file'),
  });
  /** How close to the ceiling still counts as having run out of room mid-call. */
  const TRUNCATION_MARGIN = 40;

  const { body: requestBody, unsupported } = buildModelRequest({
    turn: 'tool-turn',
    ...(opts.kind ? { kind: opts.kind } : {}),
    messages,
    tools: activeTools,
    stream: true,
    // Large enough for the biggest thing this toolset may emit. With write_file active that is a
    // whole source file, not a shell line — see turnMaxTokens. Held in a variable because the loop
    // has to compare a reply's length against it to recognise a call that was cut off.
    maxTokens: turnCap,
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
    ...(opts.fromPack?.length ? { fromPack: opts.fromPack } : {}),
    loop: {
      maxSteps,
      think,
      toolResultCap: toolResultCap ?? MAX_TOOL_RESULT_CHARS,
    },
  };

  /**
   * How the loop ended, kept because the two endings are different failures.
   *
   * Running out of steps means the work was too big for the budget: raise it, or split the leaf.
   * The model going silent means it stopped acting and started narrating — usually because
   * something it believed about the environment turned out to be false, and no larger budget
   * helps. Reporting the second as the first sent a real diagnosis down the wrong path: a leaf
   * that gave up after ten steps was reported as having exhausted forty, so the obvious response
   * was to raise a limit that was never reached.
   */
  let stoppedTalking = false;
  let stoppedAtStep = maxSteps;

  /**
   * One model call with exactly ONE tool on offer.
   *
   * ── WHY THIS IS SHARED RATHER THAN WRITTEN TWICE ──
   * Two places need the same unusual turn: the forced wrap-up when a budget runs out, and the
   * handoff when a checkpoint fires. Both work by WITHHOLDING every other tool — that is what makes
   * them a pause rather than another working turn, because the agent cannot decide to keep going,
   * which is the whole reason it was interrupted. Both must also survive failing: an interruption
   * that takes the run down with it is worse than not interrupting.
   *
   * The instruction is pushed onto `messages`, so the model sees why it was stopped. Note that the
   * checkpoint caller resets `messages` immediately afterwards, so for that path the push is
   * transient by design.
   *
   * Returns the parsed arguments when the tool was called, the prose when the model answered
   * without calling it, and undefined when the call itself failed. Callers decide what each of
   * those means — a wrap-up keeps the prose as its summary, a checkpoint records that no handoff
   * was written.
   */
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
        // Enough for an honest account of a long run, and no more.
        max_tokens: fittedMaxTokens(1200, JSON.stringify(messages).length, opts.contextTokens),
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
      // Counted like any other turn: it is a real inference against a real budget.
      tokensUsed += reply.tokens;
      completionTokensUsed += reply.completionTokens;

      const call = reply.toolCalls.find((c) => c.name === toolName);
      const content = reply.content?.trim() ?? '';
      if (!call) return { content };
      return { args: parseToolArguments(call.arguments), content };
    } catch {
      // Never fatal. The caller's own record of the run is still true without this.
      return undefined;
    }
  };
  /** Extensions granted this run, in order. Surfaced so a long run says WHY it was long. */
  const extensions: { step: number; at: 'steps' | 'tokens'; steps?: number; tokens?: number; reason: string }[] = [];
  let extensionsUsed = 0;
  /** Save points written this run. See CheckpointDriver for why the loop only decides WHEN. */
  const checkpoints: { step: number; tokensUsed: number; sha?: string; branch?: string }[] = [];
  /** Consecutive turns that inspected the workspace without changing it — see lib/thrash.ts. */
  let unproductiveTurns = 0;
  let thrashed = false;
  /** What each turn thought and did, for the circling check below. */
  const thoughts: ThoughtTurn[] = [];
  let circling = '';
  /** What it said when asked to wrap up, if it answered in prose instead of calling finish. */
  let wrapUpProse = '';


  /** Which budget ran out, for a summary that says what actually happened. */
  let exhausted: 'steps' | 'tokens' | undefined;

  /**
   * Unbounded, with BOTH ceilings decided at the top by one policy.
   *
   * It used to be `step < maxSteps` with the token check inside, which meant the two budgets were
   * enforced in two places and only one of them could ever be reconsidered. A run that has earned
   * more room has earned it whichever ceiling it hit, and putting the decision in one place is what
   * makes that true without duplicating the extension logic.
   *
   * Checked BEFORE the turn, never during: stopping mid-turn would abandon a tool call whose result
   * the agent is waiting for, and the overshoot of finishing one turn is bounded by a single reply.
   */
  for (let step = 0; ; step++) {
    const hit = tokensUsed >= maxTokens ? 'tokens' : step >= maxSteps ? 'steps' : undefined;
    if (hit) {
      /**
       * Ask whether this run deserves more room before calling it finished.
       *
       * The order matters: probe, decide, and only then checkpoint. An extension always carries a
       * checkpoint because spending +50% on the most degraded context of the run is how you buy a
       * worse outcome for more money — the save point resets the conversation, so the extra budget
       * is spent thinking rather than re-reading.
       *
       * Every veto lives in `decideExtension`, and the loop's own diagnoses are what feed it: a run
       * this loop has already identified as thrashing or circling must not be handed more room to
       * do it in. That has been measured to make outcomes worse three separate times.
       */
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

      /**
       * Told to the agent, and not optional.
       *
       * `buildAgentPrompt` bakes the step budget into the system prompt ONCE at the start of the
       * run, so an extension that is not announced leaves the agent working to a number that is no
       * longer true. sandbox-tools.ts documents exactly this class of bug — "it typechecks, it
       * runs, and the two quietly disagree" — and step-budget.test.ts exists to guard it.
       */
      messages.push({
        role: 'user',
        content: extensionNotice(extension, hit === 'steps' ? maxSteps : maxTokens, hit),
      });
    }
    /**
     * `messages` is mutated across steps and the body was built once, so the array reference is
     * shared and the conversation grows in place rather than being rebuilt per turn.
     *
     * Which is exactly why the trim has to happen HERE, per request, rather than where the body was
     * assembled: at that point the conversation is two messages long and there is nothing to trim.
     * Reassigned each turn so the full `messages` array stays intact for the trace and for the next
     * turn's own trimming.
     */
    /**
     * ── SAVE THE RUN, THEN FORGET HOW IT GOT HERE ──
     *
     * Fires at a TURN BOUNDARY, which is the only place it is safe: `write_file` is a single atomic
     * write, so the working tree is never half-finished here, and sweeping it into the checkpoint
     * commit cannot capture a partial file.
     *
     * Three things happen in one operation, deliberately — see lib/leaf-checkpoint.ts. The agent is
     * asked what it has done (the part only it knows), the driver commits and pushes and writes the
     * artifact (the part only the harness can check), and then the conversation is replaced by that
     * artifact.
     *
     * The reset is CONDITIONAL on the save succeeding. Discarding a context whose replacement failed
     * to write would turn a bookkeeping failure into a lost run, which is the exact outcome this
     * whole mechanism exists to prevent.
     */
    if (opts.checkpoint && shouldCheckpoint({ tokensUsed, maxTokens, taken: checkpoints.length })) {
      const number = checkpoints.length + 1;
      /**
       * The spend that TRIGGERED this, captured before the handoff turn adds its own.
       *
       * `tokensUsed` is mutated by `oneToolTurn` below, so reading it afterwards reports the cost
       * of the interruption as though it were the reason for it. Measured live: checkpoint 2 of a
       * 30,000-token run recorded 28,640 — which reads as a violation of the 15%-remaining rule
       * that suppresses late checkpoints, when the decision was actually taken thousands of tokens
       * earlier and the handoff turn accounted for the difference.
       */
      const triggeredAt = tokensUsed;
      /**
       * Where the conversation stood before we interrupted it.
       *
       * `oneToolTurn` appends its instruction to `messages`, and that instruction says the context
       * is ABOUT TO BE RESET. If the save then fails we do not reset — so without rewinding, the
       * agent would carry a standing announcement of something that never happened, followed by
       * its own reply to it, for the rest of the run.
       */
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

        /**
         * The reset itself. `messages` is mutated in place because `requestBody.messages` is
         * reassigned from it every turn just below — so truncating here is all that is required,
         * and the array reference the rest of the loop holds stays valid.
         *
         * The system prompt survives (it carries the persona and the memory bank); everything else
         * becomes one user message containing the artifact.
         */
        const system = messages[0];
        messages.length = 0;
        if (system) messages.push(system);
        messages.push({
          role: 'user',
          content: assembleResetPrompt(opts.taskContext.split('\n')[0] ?? 'this task', saved.artifact),
        });
      } else {
        // Rewind the interruption — see `before`. The run carries on as though it never paused.
        messages.length = before;
      }
    }

    /**
     * Trimmed against the window this run's model actually has.
     *
     * A constant here meant a 131K model kept the same 60,000 characters a 32K one did, discarding
     * history it had room for — see `conversationBudget`.
     */
    requestBody.messages = trimConversation(
      messages,
      conversationBudget(opts.contextTokens, typeof overrides.conversationGrowth === 'number' ? overrides.conversationGrowth : undefined),
    );
    /**
     * The reply budget is re-fitted every turn, because the prompt grows.
     *
     * The engine allocates prompt + max_tokens up front and refuses the pair if it does not fit, so
     * a fixed ceiling that was fine on turn one is a hard 400 on turn twenty — before a token is
     * generated. Measured: 26,816 prompt tokens plus an 8,000 ceiling is exactly the 34,816 the
     * engine reported against a 32,768 window.
     */
    requestBody.max_tokens = fittedMaxTokens(turnCap, JSON.stringify(requestBody.messages).length, opts.contextTokens);
    // Per turn, for the same reason as the messages above: the body is assembled once, and a tool
    // list fixed at that moment could never change partway through a run.
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
      /**
       * A tool call cut off mid-argument, which is NOT a model that stopped trying.
       *
       * `write_file` carries a whole file in its argument, so a long file can exhaust the turn's
       * token ceiling before the call is closed — and a half-emitted call cannot be parsed, so it
       * arrives here indistinguishable from silence. Measured: `finish_reason: tool_calls` with
       * `completion_tokens: 3997` against a ceiling of 4000, while the model dutifully
       * re-announced "Now let me create the test file:" each turn until the loop gave up.
       *
       * Told plainly, it splits the file and succeeds. Told "use a tool", it resends the same
       * oversized call.
       */
      if (completionTokens > 0 && completionTokens >= turnCap - TRUNCATION_MARGIN) {
        messages.push({
          role: 'user',
          content: 'Your last tool call was cut off because it exceeded the length limit for a '
            + 'single reply, so nothing ran. If you were writing a file, write it in SEVERAL '
            + 'smaller steps — one section per call, appending — or split it into smaller modules. '
            + 'Do not resend the same oversized call.',
        });
        publish();
        // Not counted as a silent turn: the model was acting, and the retry it needs is different.
        continue;
      }
      consecutiveNoToolTurns++;
      // Published before the nudge: a turn that produced no tool call is the failure most worth
      // watching live, and it is invisible in a progress counter.
      publish();
      // Answered in prose instead of acting. Give up after 3 consecutive turns without tools —
      // a model that has stopped using tools will usually keep narrating, and each round costs a full inference pass.
      if (consecutiveNoToolTurns >= 3 || step >= maxSteps - 1) {
        // Recorded, because these two endings need completely different fixes and the summary
        // below used to report both as "ran out of steps" — see there.
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

    /**
     * Turns that produced nothing, tracked separately from turns that called no tool.
     *
     * The step cap cannot tell a productive run from a thrashing one — it fires at the same number
     * for both, and raising it is recorded twice in sandbox-tools.ts as having made things worse.
     * This is the signal that actually separates them; see lib/thrash.ts.
     */
    /**
     * ── IS IT GOING IN CIRCLES? ──
     *
     * Checked BEFORE the production counter, because this is the case that counter cannot see: an
     * agent rewriting the same file every turn is productive by every measure thrash.ts has, and is
     * getting nowhere. Reading what it is thinking is the only thing that separates the two.
     *
     * Requires that nothing was produced this turn as well, so honest iteration — test, read the
     * failure, fix, test — is never interrupted for being repetitive, which it is by nature.
     */
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
          ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages) } : {}),
          ...(checkpoints.length ? { checkpoints } : {}),
          ...(extensions.length ? { extensions } : {}),
          ...(unsupported.length ? { unsupported } : {}),
        };
      }

      let result: string;
      try {
        /**
         * The sandbox first, always.
         *
         * A remote handler that answered for `run_command` would shadow the real one, and the
         * failure would look like the sandbox misbehaving rather than like two things sharing a
         * name. `callRemote` returns undefined for anything it does not own.
         */
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
    const note = pacingNoteFor(remaining, opts.pacing ?? CODE_PACING);
    if (note) {
      const last = messages[messages.length - 1] as { content?: string };
      last.content = `${last.content ?? ''}\n\n[${remaining} step${remaining === 1 ? '' : 's'} left of ${maxSteps}. `
        + `${note.message}]`;
    }

    // After the whole tool loop, so the step arrives complete with its results rather than as a
    // call with an empty outcome that fills in later.
    publish();
  }

  /**
   * ── ONE LAST TURN, BEFORE ANY OF THIS COUNTS AS FAILURE ──
   *
   * Running out of budget is a STOP. It was being recorded as a VERDICT, and the difference cost
   * real work: a leaf wrote 30 passing tests, committed them, pushed them to koala/7565dc49, said
   * so in prose — and then hit the step ceiling before calling `finish`. The harness recorded a
   * failure, never merged the branch, and the work sat in the outstanding list for days while the
   * code was on a branch the whole time.
   *
   * The agent knew what it had done. It was never asked. So it is asked now, with `finish` as the
   * only tool it can call, and its answer flows through verification exactly like any other — a
   * claim, checked where checkable, never trusted on its own.
   *
   * A dishonest wrap-up gains nothing: `decideStatus` lets a verification overrule the claim in
   * both directions, so claiming success here still fails against a red suite.
   */
  /**
   * Only for a BUDGET stop.
   *
   * Thrashing and answering-in-prose are diagnoses, not interruptions: the loop already knows
   * something is wrong and its own account of that ("it inspected the workspace six times without
   * changing it") is far more useful than asking the agent, which is the thing that was confused.
   * Budget exhaustion is the only stop where the agent may genuinely have more to report.
   */
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
      /**
       * It answered in prose instead of calling the tool. That prose is still the best account of
       * where things stand — it is exactly what was thrown away before — so it is kept as the
       * summary, but the run is NOT claimed as succeeded on the strength of it.
       *
       * Kept alongside the budget diagnosis below rather than replacing it, so the run is still
       * classified correctly and the account is not lost. Replacing it made a run that simply ran
       * out report its last idle thought.
       */
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
        // Said plainly so nothing downstream mistakes a forced wrap-up for a run that ended on its
        // own terms.
        outOfBudget: true,
        stoppedBecause: 'budget',
        ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages) } : {}),
        ...(checkpoints.length ? { checkpoints } : {}),
        ...(extensions.length ? { extensions } : {}),
        ...(unsupported.length ? { unsupported } : {}),
      };
    }
  }

  return {
    succeeded: false,
    // Only when a BUDGET ran out. Circling, thrashing and answering-in-prose are diagnoses, and
    // marking them as budget stops would have the project's outstanding list report a confused run
    // as one that merely needed more room.
    ...(!circling && !thrashed && !stoppedTalking ? { outOfBudget: true } : {}),
    // The same three conditions the summary below branches on, as a value the caller can act on.
    stoppedBecause: circling ? 'circling' : thrashed ? 'thrashing' : stoppedTalking ? 'silent' : 'budget',
    summary: circling
      // Its own message, quoting what repeated, so the verdict can be checked rather than trusted.
      ? `${circling} Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`
      : thrashed
      ? thrashSummary(unproductiveTurns, transcript)
      : stoppedTalking
      ? `Stopped calling tools after ${stoppedAtStep} step(s) of ${maxSteps} — it answered in prose `
        + `three turns running instead of acting, which usually means something it believed about the `
        + `environment was wrong. Last commands: ${transcript.slice(-3).join(' | ') || 'none'}`
      : wrapUpProse
        // Its own account of where things stand, kept because that is exactly what was thrown away
        // when a leaf explained in prose that it had already committed and pushed the work.
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
    ...(opts.captureTrace ? { trace, conversation: snapshotConversation(messages) } : {}),
    ...(checkpoints.length ? { checkpoints } : {}),
    ...(extensions.length ? { extensions } : {}),
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

    /**
     * ── THIS USED TO RETURN `saved: true` AND WRITE NOTHING ──
     *
     * The tool was declared, offered, and answered "Memory recorded and sent to Memory Bank review
     * queue." while never calling `saveMemory`. So the `source: 'agent_tool'` enum value was dead,
     * every agent that used it was told it had worked, and — worse —
     * `seed-harder-benchmark-experiment.ts` contains a task that SCORES an agent on calling it. The
     * suite was rewarding a no-op and reporting the score as a capability.
     *
     * Behind a callback, for the same reason `web`, `callRemote` and `checkpoint` are: the loop has
     * no database and must stay drivable from a test without one. Absent means the caller cannot
     * persist, and the honest answer is to say so rather than claim success.
     */
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

    /**
     * Says what actually happened, which is no longer always "saved".
     *
     * This used to answer "Queued for review", because everything a model concluded waited for a
     * human. Nobody drained that queue — 124 of 143 memories were sitting in it — so admission is
     * now a decision made against the entries already stored (lib/memory-decide.ts), and a
     * candidate can be judged a duplicate and dropped. An agent told "saved" when nothing was
     * stored would stop repeating a lesson that is not recorded anywhere.
     */
    const noted = action === 'NOOP'
      ? 'Not stored — the memory bank already holds this. Nothing more to do.'
      : 'Stored. It will be available to future runs on this project.';

    return JSON.stringify({ saved: action !== 'NOOP', action, category, title, suggestedScope, note: noted });
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

  /**
   * The web, through whatever this platform actually has deployed.
   *
   * Both of these used to be implemented inline here — a DuckDuckGo HTML scrape and a regex
   * tag-stripper — while the chat path went through `resolveWebTools` to the SearXNG and Crawl4AI
   * the user provisioned. Two implementations of the same tool, and the agent doing the research
   * had the worse one.
   *
   * Absent when the caller supplied no tools, which is not the same as a search returning nothing:
   * an agent told "no web tools" stops trying, whereas one told "no results" searches again. The
   * Lab spent a whole run learning that distinction the hard way, reporting that it had no internet
   * access while its arms curled a sandbox with default-deny egress.
   */
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

        /**
         * ── THE SENTENCE THAT COST A PROJECT ITS BUDGET ──
         *
         * This used to answer "No results found" whenever the array came back empty — whether the
         * topic was genuinely empty, the backend was unreachable, or the fallback was rate-limited.
         * A Researcher received it nineteen times, broadened from a precise query down to bare
         * `HTML` and `CSS`, then looped two terms for fifteen steps and failed at 204K tokens.
         * SearXNG answers those queries with ten results each; nothing was wrong with the topic.
         *
         * So the two cases are now told apart, and the unavailable one says explicitly that
         * rephrasing will not help. An agent cannot reason its way out of a false negative it has
         * no way to detect.
         */
        return JSON.stringify(renderSearchOutcome(query, outcome));
      } catch (err: any) {
        // An exception is also not a negative result. Same distinction, said the same way.
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


/**
 * Reads one streamed completion into content, tool calls and a token count.
 *
 * Tool-call reassembly is delegated to ToolCallScanner — the same code the chat route uses, and
 * already tested against the fragment shapes this endpoint emits — while content and usage are
 * pulled from the same frames in one pass.
 */
/**
 * Exported because the review route needs it for the same reason this loop does: TabbyAPI's
 * non-streamed replies are unreliable — it reports `usage: null` (documented at the top of this
 * file) and, measured on the review route, ignores `max_tokens` entirely, returning ~1,600 tokens
 * against a cap of 900. Streamed, the cap is honoured.
 */
export async function readStreamedReply(
  response: { body?: any; text?: () => Promise<string> },
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  tokens: number;
  /** As the server reported it. `length` means the reply was cut off, not that it finished. */
  finishReason: string;
  completionTokens: number;
}> {
  const scanner = new ToolCallScanner();
  // Debug hatch: dumps the raw SSE of a turn so a reply that produced no tool call can be read as
  // the server actually sent it, finish_reason included. Off unless KOALA_DEBUG_RAW is set.
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
        // Its own field, not inline <think> tags — measured against the live endpoint.
        reasoning += delta?.reasoning_content ?? '';
        // Usage arrives on its own final frame, after the last content frame.
        if (frame?.usage?.total_tokens) tokens = Number(frame.usage.total_tokens);
        if (frame?.usage?.completion_tokens) completionTokens = Number(frame.usage.completion_tokens);
        // Last one wins: it arrives on the final frame of the choice.
        if (frame?.choices?.[0]?.finish_reason) finishReason = String(frame.choices[0].finish_reason);
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

  const calls = scanner.result();
  if (process.env.KOALA_DEBUG_RAW && !calls.length) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.KOALA_DEBUG_RAW, `\n===== TURN WITH NO TOOL CALL =====\n${rawSink.join('')}\n`);
  }
  return { content, reasoning, toolCalls: calls, tokens, finishReason, completionTokens };
}
