/**
 * The shapes that cross the wire between the backend and the Lab.
 *
 * ── WHY THIS PACKAGE EXISTS ──
 * Every one of these was declared twice — once in `apps/backend/src/lib`, once by hand in
 * `apps/frontend/src/components/Lab.tsx` — with nothing checking that the two agreed. That is fine
 * until it isn't, and it stopped being fine twice in one day: changing `AgentRequest.tools` from
 * `string[]` to `{name, description}[]` needed matching edits in two files plus a test fixture that
 * was silently wrong until it failed, and `LEGACY_TASK_ID` sat in the UI under a comment reading
 * "must match the backend" — a constant that must match and could not be checked.
 *
 * A drifting wire contract fails in the worst available way: the compiler is happy, the request
 * succeeds, and a field reads as `undefined` at runtime in a surface whose entire job is reporting
 * numbers accurately.
 *
 * ── TYPES ONLY, DELIBERATELY ──
 * Not one runtime value lives here, and that is a constraint rather than an accident. Every import
 * of this package is an `import type`, which both TypeScript configurations erase before anything
 * executes — so neither `tsx` nor Vite ever has to resolve it, and there is no build step, no
 * bundling question, and no way for a version of this package to be stale at runtime.
 *
 * Adding a `const` here would quietly end that property. Constants that both sides need belong in
 * the payload the server already sends: the harness limits and the tunable registry are served
 * over `/api/harness/config` for exactly this reason, and the task-id normalisation that used to
 * need a shared constant is now done server-side instead.
 */

/**
 * The languages a workspace can be created for.
 *
 * A closed set rather than a free-text image field, so a model can never name an image nobody
 * vetted. The catalogue itself — images, tool lists — stays in the backend; only the identifier
 * crosses the wire.
 */
export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base';

/** Inference engine, when the platform deployed it and therefore knows what it is. */
export type ModelKind = 'vllm' | 'tabbyapi';

/* ── the agent loop ───────────────────────────────────────────────────────── */

/**
 * One turn of the loop, kept so a run can be read afterwards.
 *
 * A step showing no reasoning is itself informative: it means thinking was off for that variant.
 * A step showing no tool call is the failure the dispatch loop is most vulnerable to.
 */
export interface AgentStep {
  step: number;
  reasoning?: string;
  content?: string;
  toolCalls: { name: string; arguments: string }[];
  toolResults: { name: string; result: string }[];
  tokens: number;
  /** Set when a field was cut to fit the per-field caps. */
  truncated?: boolean;
}

/**
 * One message in the conversation, exactly as it went to the model.
 *
 * ── WHY THIS IS NOT THE TRACE ──
 * `AgentStep` is a reconstruction: fields pulled out of each turn and re-assembled for display.
 * That is useful and it is not the same thing. The tool results it holds are clipped to 1,200
 * characters while the model was actually sent up to 8,000, so reading a trace tells you roughly
 * what happened and quietly misrepresents what the model saw — which is the one question a
 * transparency view exists to answer.
 *
 * This is the array the request was built from. Nothing is inferred.
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on an assistant turn that called tools. */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** Ties a tool result back to the call it answers. */
  toolCallId?: string;
  name?: string;
  /** Set when a field was cut to fit the caps — so a shortened message never reads as complete. */
  truncated?: boolean;
}

/**
 * Exactly what the model was asked.
 *
 * A score without its input is a claim nobody can check. Deliberately carries no base URL and no
 * API key: a record that outlives the run must not carry the means to make more of them.
 */
export interface AgentRequest {
  systemPrompt: string;
  kickoff: string;
  model?: string | undefined;
  /** With descriptions, because a tool the model ignores may simply be one described badly. */
  tools: { name: string; description: string }[];
  /** Sampler and template fields as sent, minus messages and tools. */
  parameters: Record<string, unknown>;
  /** What was ASKED for. Differs from `parameters` exactly when something was dropped or read locally. */
  overrides?: Overrides;
  /** Knobs that could not be sent — an unknown key, or an engine-gated sampler on another engine. */
  unsupported?: string[];
  /**
   * Keys whose value came from the promoted profile rather than from the variant.
   *
   * Without this the two are indistinguishable in the record, and a variant named after a
   * configuration it is no longer running looks exactly like one that is. That happened: a
   * promoted prompt silently became the baseline for a control arm called `shipped-prompt`.
   */
  fromProfile?: string[];
  /**
   * Keys whose value came from a persona rather than from the variant or the profile.
   *
   * Separate from `fromProfile` because they answer different questions — "this install decided
   * that" versus "this arm was run as someone" — and an experiment comparing two personas is
   * unreadable if both collapse into one list.
   */
  fromPersona?: string[];
  /** Loop controls, which never appear in `parameters` because they are never transmitted. */
  loop?: { maxSteps: number; think: boolean; toolResultCap: number };
}

/* ── tunables ─────────────────────────────────────────────────────────────── */

/** Overrides as they travel: an open bag, validated against the registry rather than by its type. */
export type Overrides = Record<string, unknown>;

/**
 * Where a value goes once it leaves the registry.
 *
 * Not a stylistic distinction: `enable_thinking` is read only when nested under `template_vars`,
 * and sent at the top level it is accepted, ignored, and the model quietly degrades.
 */
export type TunablePlacement = 'body' | 'template_vars' | 'loop';

export type TunableType = 'number' | 'boolean' | 'string' | 'enum';

/** One knob the harness can change about a model call, as served to the UI. */
export interface Tunable {
  key: string;
  label: string;
  group: 'sampling' | 'loop' | 'prompt';
  type: TunableType;
  placement: TunablePlacement;
  /** The wire field when it differs from `key` — `think` is sent as `enable_thinking`. */
  field?: string;
  /** Send only to this engine; dropped elsewhere rather than risking a 400. */
  engine?: ModelKind;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  /**
   * Where the pickable values come from, when they are discovered at runtime rather than fixed.
   *
   * The registry cannot list a user's models: they are deployments and endpoints that come and go,
   * and they differ per tenant. So the knob declares the source and the config fills `choices` in
   * per request — which keeps the picker honest without the UI knowing that `model` is special.
   */
  choicesFrom?: 'models';
  /**
   * Which config layers may set this knob. Absent means all three.
   *
   * ── WHY A KNOB WOULD BE RESTRICTED ──
   * `resolveConfig` layers profile → persona → request, so a profile value applies to every persona
   * in every project at once. For most knobs that is the point. For `model` it is not: which engine
   * answers is part of what a persona IS, and one profile field silently repointing every leaf —
   * and, since budgets follow the model's window, silently resizing every leaf's context — is not
   * something a single setting should be able to do.
   */
  settableAt?: ('profile' | 'persona' | 'request')[];
  /** Filled in by `buildHarnessConfig` for knobs with `choicesFrom`. Never authored by hand. */
  choices?: { value: string; label: string; note?: string }[];
  /** What the harness runs at today, read from the defining module rather than restated. */
  default: unknown;
  /**
   * The prompt in `HarnessConfig.prompts` this knob replaces, when its default is generated per
   * task rather than being a constant `default` can hold.
   *
   * Declared here so an editor can open on the text actually in force. The alternative — a UI that
   * checks for `systemPrompt` by name — is the hardcoding that makes a new prompt knob invisible
   * until someone remembers to add a case.
   */
  promptId?: string;
  /** The two ends worth comparing, which is what makes a knob a one-click axis. */
  suggested?: unknown[];
  note?: string;
  source: string;
}

/** One knob's actual runtime value, and why it has it. */
export interface EffectiveKnob {
  key: string;
  label: string;
  group: Tunable['group'];
  value: unknown;
  /** `harness` is the built-in constant; `adopted` means a promoted profile supplies it. */
  source: 'harness' | 'adopted';
  note?: string;
  sourceFile: string;
}

/* ── experiments ──────────────────────────────────────────────────────────── */

/** The settings a variant changes. `language` selects an image, so it is not a request parameter. */
export type ExperimentOverrides = Overrides & { language?: WorkspaceLanguage };

export interface ExperimentVariant {
  label: string;
  overrides: ExperimentOverrides;
  /**
   * A persona this arm runs as, resolved beneath its own overrides.
   *
   * What makes personas comparable: a variant is already a named override bag, so pointing two of
   * them at different personas runs those personas head to head on the same suite — which is the
   * only way to answer "which one is actually better" rather than preferring the one you wrote
   * most recently. The variant's own overrides still win, so an arm can borrow a persona and
   * change one knob.
   */
  personaId?: string;
}

/** A file written into the sandbox. Relative to /work; paths that escape it are rejected. */
export interface TaskFile {
  path: string;
  content: string;
}

/**
 * One task in the suite.
 *
 * The verify command belongs here rather than on the experiment: tasks in a useful suite check
 * different things, and one shared command would either fit a single task or verify nothing.
 *
 * ── WHY A TASK HAS FOUR PARTS ──
 * It used to have two — a prompt and a verify command — and that shape made a whole category of
 * task impossible to express. "Read data.txt and print it" needs data.txt to already exist, and
 * with nowhere to put it the only available move was to have the verify command create its own
 * input. Which it did, on a real authored suite: the file then existed only at verification time,
 * the agent spent 24 steps trying to invent it, and the task could never have passed.
 *
 * `seed` is the world the agent wakes up in. `solution` is a reference correct answer, used ONLY
 * to prove the verify command can pass — it is never placed in a real run's sandbox.
 */
export interface ExperimentTask {
  id: string;
  name: string;
  prompt: string;
  verifyCommand: string;
  /** Present in /work before the agent starts. The given state of the task. */
  /**
   * Which cycle this task exercises.
   *
   * `sandbox` (the default) runs the execution loop: the agent works in /work and verify checks
   * what it left. `planning` runs the decomposition loop instead — the agent answers a request by
   * proposing leaves, and verify reads those leaves as `leaves.json`.
   *
   * A field rather than two task types because everything else is identical: both have a prompt,
   * both are gated the same two-sided way, and both are verified by a command's exit code in a
   * sandbox. The first experiment written against planning used a sandbox task and checked for a
   * file the sandbox loop has no tool to produce — this is what makes that unrepresentable.
   */
  /**
   * Whether this task runs the planning turn instead of the execution loop.
   *
   * A structural difference, not a classification: the planning turn has no sandbox at all, so its
   * result is a set of proposed leaves rather than a workspace to inspect. Everything else about
   * the run — model, sampling, tools, network, budget — comes off the arm's persona.
   */
  planning?: boolean;
  seed?: TaskFile[];
  /**
   * A correct answer, for validation only.
   *
   * The gate proves a verify command FAILS with only the seed present. That says it is not
   * vacuous; it does not say it can ever succeed. A verify with a typo — `grep -q 'Hello Wolrd'` —
   * fails on the seed and fails on a perfect solution, and nothing today can tell those apart.
   * Running the verify against seed + solution is what turns "achievable" into a fact.
   */
  solution?: TaskFile[];
  /** Overrides the suite default, so one suite can span languages. */
  language?: WorkspaceLanguage;
}

export type ExperimentStatus = 'draft' | 'running' | 'complete' | 'failed';

/** One run, in full. Lives on the detail route — never in the polled list. */
export interface VariantResult {
  label: string;
  taskId?: string;
  /** What the AGENT claimed. */
  succeeded: boolean;
  /** What the verify command found. This is the one that counts. */
  verified: boolean;
  verifyExitCode: number;
  verifyOutput: string;
  steps: number;
  tokensUsed: number;
  durationMs: number;
  summary: string;
  transcript: string[];
  /** Exactly what the model was sent. */
  request?: AgentRequest;
  /**
   * The whole conversation, verbatim.
   *
   * What the model was SENT, turn by turn, including the tool results as it received them. The
   * trace below is what it PRODUCED, reasoning included — the two answer different questions and
   * neither substitutes for the other.
   */
  conversation?: ConversationMessage[];
  /** What the task said success looks like, stored so a result stays readable after an edit. */
  expected?: { verifyCommand: string; note: string };
  trace?: AgentStep[];
  /**
   * What the run actually changed, captured before its sandbox was destroyed.
   *
   * Exists so a judge can be CALIBRATED. An experiment run is the only place in this system with
   * independent ground truth — a verify command whose exit code no model influenced — so it is the
   * only corpus a model's judgement can be scored against. Without a diff there is nothing to score
   * it ON, and `trace` will not substitute: MAX_TRACE_TOOL_ARGS clips `write_file` payloads, which
   * is exactly the content that matters.
   *
   * Deliberately excludes the task's `solution`. That exists to gate the verify command two-sided,
   * and showing it to a judge would make its job a different and much easier one than the live case.
   */
  evidence?: { diff?: string; diffTruncated?: boolean };
  /** Distinct tools called by the agent during this variant execution. */
  toolsUsed?: string[];
  /** Whether the agent invoked the expected dedicated tool for this task rather than falling back to run_command alone. */
  usedDedicatedTool?: boolean;
  /** Set when the run could not complete at all — a broken endpoint, not a failed task. */
  error?: string;
}

/**
 * One execution of an experiment, with the configuration it ran under.
 *
 * ── WHY EXECUTIONS ARE KEPT SEPARATELY ──
 * Running an experiment used to clear its results, which made an experiment a thing you could only
 * ask once. The entire reason to record a suite is to ask it AGAIN after changing something — a
 * reworded prompt, a promoted default, a different model — and see whether the numbers moved. That
 * comparison is impossible if the previous numbers were deleted to make room.
 *
 * The context travels with each execution because "the numbers moved" is only meaningful beside
 * what changed. A run that does not remember which model produced it cannot be compared with one
 * that used a different model, and the difference would be attributed to whatever was being tested.
 */
export interface ExperimentRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'failed';
  /** The model actually resolved for this execution. */
  model?: string;
  /** The promoted profile in force, so an adopted default is visible as part of the conditions. */
  profileOverrides?: Overrides;
  results: VariantResult[];
  progress?: string | undefined;
  error?: string | undefined;
}

/** One execution as the list carries it: enough to offer a comparison, none of the evidence. */
export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'failed';
  model?: string;
  /** Verified over attempted, across the whole suite — the headline for that execution. */
  verified: number;
  /** Every run in the execution, including the ones nothing could be learned from. */
  runs: number;
  /**
   * Runs that got a fair attempt — `runs` minus the broken ones, and the denominator to show.
   *
   * Kept beside `runs` rather than replacing it: an execution where half the runs died is a
   * different fact from one where they all ran, and a single number cannot carry both.
   */
  attempted: number;
  /** Runs that never got a fair attempt. Non-zero means the score rests on less than it appears. */
  broken: number;
}

export interface Experiment {
  id: string;
  ownerId: string;
  name: string;
  /**
   * Every execution, oldest first.
   *
   * `results` below mirrors the latest one, so existing readers keep working; this is what makes
   * "re-run it after the change and compare" possible at all.
   */
  runs?: ExperimentRun[];
  tasks?: ExperimentTask[];
  /** The single task an experiment used to hold, kept readable rather than migrated. */
  task?: string;
  verifyCommand?: string;
  language: WorkspaceLanguage;
  variants: ExperimentVariant[];
  repeats: number;
  status: ExperimentStatus;
  results: VariantResult[];
  progress?: string | undefined;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
  /**
   * Recomputed per request: only the running service knows whether work is actually in flight.
   *
   * The detail route has always sent this and the summary has always declared it; this did not,
   * so a reader of the detail could only consult `status` — which lags, because it is written when
   * a run finishes rather than while it goes.
   */
  running?: boolean;
}

/* ── the list view ────────────────────────────────────────────────────────── */

/**
 * What the polled list carries: scores, no evidence.
 *
 * Traces, prompts, verify output and request records are on the detail route. Anything added here
 * is re-sent for the whole archive on every poll, which is what made persisting history a
 * performance regression rather than a feature.
 */
export interface ResultSummary {
  label: string;
  /** Always resolved by the server, so the client never needs to know about pre-suite records. */
  taskId: string;
  succeeded: boolean;
  verified: boolean;
  verifyExitCode: number;
  steps: number;
  tokensUsed: number;
  durationMs: number;
  toolsUsed?: string[];
  usedDedicatedTool?: boolean;
  /** Presence drives the medians and the "didn't run" count; the text is on the detail. */
  error?: string;
}

/** Task identity only. Prompts are the largest field in a record and the list never shows them. */
export interface TaskSummary {
  id: string;
  name: string;
  language?: WorkspaceLanguage;
}

export interface ExperimentSummary {
  id: string;
  ownerId: string;
  name: string;
  language: WorkspaceLanguage;
  /** Always present and always normalised, whatever era the record comes from. */
  tasks: TaskSummary[];
  variants: ExperimentVariant[];
  repeats: number;
  status: ExperimentStatus;
  /** The latest execution's results. */
  results: ResultSummary[];
  /** Every execution, oldest first — what makes "re-run after the change" comparable. */
  history: RunSummary[];
  progress?: string | undefined;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
  /** Recomputed per request: only the running service knows whether work is actually in flight. */
  running?: boolean;
}

/* ── live run events ──────────────────────────────────────────────────────── */

/**
 * Socket payloads for a run in flight.
 *
 * These cross the wire exactly as the HTTP shapes do, and were the last part of the contract still
 * typed as `any` on the receiving end — which is how a renamed field would have silently emptied
 * the live panel while everything still compiled.
 */
export interface ExperimentRunStarted {
  experimentId: string;
  taskId: string;
  taskName: string;
  label: string;
  repeat: number;
  /** Position in the plan, so the panel can say "run 3/12" without recomputing it. */
  done: number;
  total: number;
}

export interface ExperimentStepEvent {
  experimentId: string;
  taskId: string;
  label: string;
  step: AgentStep;
}

export interface ExperimentRunFinished {
  experimentId: string;
  taskId: string;
  label: string;
  verified: boolean;
  succeeded: boolean;
  steps: number;
  error?: string;
}

/* ── promoted defaults ────────────────────────────────────────────────────── */

/** Why a promoted default is what it is. A setting that cannot explain itself is an unexplained number. */
export interface PromotionProvenance {
  experimentId: string;
  experimentName: string;
  variantLabel: string;
  verified: number;
  runs: number;
  tasks: number;
  /** False is allowed and must stay visible — adopting a loser is a choice, not an accident. */
  wasBest: boolean;
  promotedAt: string;
}

/**
 * A configuration that WAS in force, kept when something replaced it.
 *
 * The promoted profile is the one piece of a run's configuration that lives in the database rather
 * than in git — the agent prompt is already versioned as code. Without this, adopting a default is
 * an unrecoverable act: there is no diff, no "what was it before", and no way back.
 */
export interface ProfileVersion {
  id: string;
  overrides: Overrides;
  /** Why it was adopted, carried forward so an old version still explains itself. */
  from?: PromotionProvenance;
  /** When it stopped being in force. */
  supersededAt: string;
}

export interface HarnessProfile {
  ownerId: string;
  /** Applied beneath a variant's own overrides, so a promoted value stays testable. */
  overrides: Overrides;
  /**
   * The persona the winning arm ran as, if it ran as one.
   *
   * ── WHY THIS IS HERE ──
   * Promotion copied `overrides` and nothing else. An arm that won BECAUSE of its persona therefore
   * handed Koala its sampling knobs and silently dropped the prompt that actually won — reporting a
   * successful promotion the whole time. The Lab could discover something the product could never
   * receive.
   *
   * Applied beneath a leaf's own persona, exactly as `overrides` sits beneath a variant's: adopting
   * a default must not stop a specific piece of work choosing differently.
   */
  personaId?: string;
  from?: PromotionProvenance;
  /** Everything this profile used to be, oldest first. Bounded — see MAX_PROFILE_HISTORY. */
  history?: ProfileVersion[];
  updatedAt: string;
}

export interface PromotionStanding {
  label: string;
  verified: number;
  runs: number;
  /**
   * Fair attempts — what the rate is computed over.
   *
   * `standingOf` documented its intent as ranking by rate "because variants can differ in run count
   * when one errored", then divided by the total anyway. An arm whose runs were killed by the
   * harness therefore ranked below one that merely lost, and promotion is the decision least able
   * to afford that.
   */
  attempted: number;
  broken: number;
  tasks: number;
  /** 1 when this variant verified the most. */
  rank: number;
  wasBest: boolean;
  /** Verified-rate gap to the best variant. Zero when this IS the best. */
  behindBy: number;
  /** Median tokens, so a tie can still be decided on cost. */
  medianTokens: number;
}

export interface OverrideChange {
  key: string;
  label: string;
  from: unknown;
  to: unknown;
}

/* ── the configuration surface ────────────────────────────────────────────── */

export interface HarnessSetting {
  label: string;
  value: string;
  /** Why it is this value — usually the failure that set it. */
  note?: string;
  /** Where to change it. */
  source: string;
}

export interface HarnessSection {
  id: string;
  title: string;
  summary: string;
  settings: HarnessSetting[];
}

export interface HarnessConfig {
  sections: HarnessSection[];
  /** Prompts in full, so what the model is told is inspectable rather than described. */
  prompts: { id: string; title: string; text: string }[];
  languages: { id: WorkspaceLanguage; image: string; summary: string }[];
  /**
   * The model APIs this caller can actually reach — deployed engines and registered endpoints.
   *
   * Deliberately trimmed from `ModelProvider`: base URLs and API-key presence describe where a
   * tenant's machines are, and this page is about what the harness is set to, not reachability.
   */
  models: { id: string; name: string; model: string; source: string; kind?: ModelKind }[];
  /** Served rather than duplicated, so the form cannot promise a run the server refuses. */
  limits: {
    maxVariants: number;
    maxRepeats: number;
    maxTaskChars: number;
    maxTasks: number;
    /** The product ceiling — tasks × variants × repeats — which is the one that binds. */
    maxTotalRuns: number;
  };
  /** Every knob an experiment can vary, so the picker cannot offer one the request never carries. */
  tunables: Tunable[];
  /**
   * What the agent is ACTUALLY running with, adopted defaults folded in.
   *
   * Distinct from `tunables[].default`, which is the built-in constant. Once a profile has been
   * promoted those differ, and the point of the Lab is tuning the harness — so a default shown
   * anywhere has to be the one in force, not the one in the source file.
   */
  effective: EffectiveKnob[];
}

/* ── personas ─────────────────────────────────────────────────────────────── */

/**
 * A named configuration you can pick, rather than the single one everybody gets.
 *
 * ── A PERSONA IS A PROFILE WITH A NAME ──
 * Deliberately the same shape as `HarnessProfile`: a system prompt and an overrides bag validated
 * against the same registry. The difference is arity and scope — a profile is one adopted default
 * for everything, a persona is one of several, chosen per conversation or per leaf. Inventing a
 * second configuration mechanism would mean a second validator, a second provenance record, and
 * two places for "what did this actually run" to disagree.
 *
 * What it is NOT, yet: a router, a tool policy, or an actor that delegates. Those are real
 * features and each needs its own design; none of them are implied by giving a prompt a name.
 */
/**
 * Where a persona belongs.
 *
 * ── WHY THIS EXISTS ──
 * A persona was a name, a prompt and some sampling, with nothing saying what it was FOR. So the
 * "Framer" persona — whose whole job is turning one big question into several small ones, and which
 * must never search — was attached to a research leaf, which grants web tools automatically. It
 * spent its entire budget searching and produced nothing. Five hundred seconds, measured, for a
 * pairing that never made sense.
 *
 * Every field is optional and absent means "anywhere". A persona written before this existed keeps
 * working exactly as it did, and a genuinely general-purpose one never has to pretend otherwise.
 */
/** One hole in the sandbox's default-deny egress policy. Mirrors the backend's EgressRule. */
export type PersonaEgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

export interface PersonaScope {
  /**
   * The workspace image this persona works in.
   *
   * Environment, not a filter: it says what toolchain the sandbox has, rather than restricting what
   * the persona is permitted to be asked. Absent leaves the caller's own default.
   */
  language?: string;
  /** CPU limit for the sandbox, e.g. "2". Absent takes the platform default. */
  cpu?: string;
  /** Memory limit for the sandbox, e.g. "2Gi". Absent takes the platform default. */
  memory?: string;
  /**
   * Variables injected into the container.
   *
   * ── WHY THESE LIVE ON THE PERSONA ──
   * If a persona needs something present in its container — a token, an endpoint, a flag that turns
   * a tool on — that requirement belongs to the persona, not to whatever code happened to create
   * the sandbox. The alternative is what this codebase already had: a caller deciding, from the
   * shape of the work, what the environment should contain, so the same persona got a different
   * container depending on where it was run from.
   *
   * Applied AFTER the fixed toolchain variables (HOME, the cache paths), so a persona can override
   * one deliberately. Those exist because a read-only root filesystem breaks every toolchain that
   * wants somewhere to cache; overriding them is a choice, not an accident.
   */
  env?: { name: string; value: string }[];
  /**
   * Whether this persona works in the project's repository.
   *
   * ── ABSENT MEANS NO ──
   * A repository is something a persona ASKS for, like the web or a larger budget. Most work is not
   * a codebase: asking a question, comparing two options, writing up what was found — none of it
   * needs a checkout, and giving it one creates an empty repository nobody will ever open.
   *
   * The default used to be yes, on the grounds that no persona should silently lose its checkout.
   * That is the same assumption that produced the sprawl this platform already cleaned up: 27
   * projects existed and 26 had never produced a build, one per request, created because something
   * decided every piece of work must have somewhere to commit.
   *
   * A persona that writes files says so, and gets a checkout, a branch and a push.
   */
  repo?: boolean;
  /**
   * The single file this persona's deliverable lands in, if it has one.
   *
   * Declared because the persona is the thing doing the writing, and because it is what makes
   * verification possible without asking what CATEGORY of work this is: the check is "the thing you
   * said you would produce is there and is not a stub".
   */
  output?: string;
  /**
   * Whether claims in that output must carry a source URL.
   *
   * Measured: an answer with no sources passed as verified, and an outline of headings with
   * "(To be filled)" passed as verified, because the only check was that the file was non-empty.
   */
  requireSources?: boolean;
  /**
   * The tools this persona may use, by name.
   *
   * ── SAVED, NOT DERIVED ──
   * The alternative was inferring a toolset from the kind of work: research gets the web, code gets
   * the repository. That inference is what cost a run. The "Framer" persona turns one big question
   * into several and must never search, but it was assigned to a research leaf, research grants web
   * tools, and it spent its whole budget searching. Nothing was wrong with the persona or the leaf
   * — the toolset was decided by neither of them.
   *
   * Stored on the record, so a persona that must not search cannot be handed a search tool by
   * something else's default. Absent means "whatever the work provides", which is what every
   * persona written before this did.
   *
   * An allowlist, not a request: the harness offers the INTERSECTION of this and what the
   * environment actually has. Naming a tool that is not available does not conjure it.
   */
  tools?: string[];
  /**
   * The sandbox this persona expects: what it may reach on the network.
   *
   * ── WHY THIS IS ON THE PERSONA ──
   * Egress was decided by the caller from the shape of the work — a leaf with a checkout got Gitea,
   * everything else got nothing. So what a persona could reach was a property of the job it happened
   * to be attached to, and the persona itself had no say in the environment it needs. That is the
   * same mistake as deriving its toolset: the two are one decision, and both belong on the record.
   *
   * Absent means the caller's own default, which is what every persona written before this got.
   * Empty means DEFAULT-DENY with nothing opened, which is a real and different choice — a persona
   * that must not reach the network says so with `[]`.
   *
   * The base policy is deny-all with DNS excepted; these are holes in it. The namespace form is the
   * one to reach for: a NodePort address does not work as a `cidr` because kube-proxy rewrites the
   * destination before the policy is evaluated, and the rule silently fails closed.
   */
  egress?: PersonaEgressRule[];
  /**
   * The shape of the run itself: how long it gets, what it is told as time runs out, and what is
   * taken away partway through.
   *
   * ── WHY THIS IS HERE AND NOT DERIVED ──
   * These were computed from the kind of work — research meant a hundred steps, the pacing notes
   * about writing rather than committing, and losing search halfway. That put the environment back
   * in the caller after the tools and the network had just been moved onto the record, and it meant
   * a Lab arm could only test a configuration the harness already knew how to name.
   *
   * With them here, a variation IS a persona: "Researcher, but forty steps" is a persona, testable
   * against its parent on the same suite. Nothing needs a new branch in the code to become
   * measurable.
   */
  /**
   * MCP servers this persona may call, by service name.
   *
   * Opt-in, never automatic. Every tool offered costs prompt tokens on EVERY turn, so a persona
   * that silently gained eleven of them because somebody deployed something unrelated would get
   * slower and more expensive with no change anybody made.
   *
   * It is also a NETWORK decision: the sandbox's egress has to allow the server's namespace, and a
   * capability the policy forbids is a tool that is visible and times out. `mcpGaps` reports that
   * disagreement rather than leaving it to be discovered mid-run.
   */
  mcp?: string[];
  run?: {
    /**
     * A safety ceiling on turns, not a working budget.
     *
     * A step can be 200 tokens or 20,000, so counting them bounds neither spend nor time. It is
     * `maxTokens` that should normally stop a run — see MAX_AGENT_STEPS for what raising this cost
     * before the two were separated.
     */
    maxSteps?: number;
    /** What the run may spend. The bound that corresponds to an actual cost. */
    maxTokens?: number;
    /**
     * Tools removed once the run passes a step, and which.
     *
     * Instructions were not enough: across four measured runs a research agent searched until its
     * budget was gone regardless of what it was told. Removing the tool is the only version of
     * "stop now" that does not require the model to agree.
     */
    withdraw?: { afterStep: number; tools: string[] };
    /**
     * What to say as the budget runs down, and when.
     *
     * The default talks about committing and pushing, which is wrong for a persona with no
     * repository — it was being told to save its work somewhere that does not exist.
     */
    pacing?: { atRemaining: number; message: string }[];
  };
  /**
   * The model this persona's PROMPT was written and checked against.
   *
   * Recorded, shown, and never enforced. Prompts do transfer between models — imperfectly — so
   * refusing to run one elsewhere would throw away working configurations to prevent a problem that
   * may not exist. What it stops is the silent case: a prompt tuned on one engine quietly carried
   * to another with nothing saying so.
   *
   * Distinct from `overrides.model`, which PINS the model. This only says where it was validated.
   */
  tunedFor?: string;
}

export interface Persona {
  id: string;
  ownerId: string;
  name: string;
  /**
   * A persona this one refines.
   *
   * Its prompt, sampling and scope are the base; anything set here wins. This is what makes trying
   * a variation cheap — "Researcher, but colder and with half the steps" is a three-line record
   * rather than a copy that drifts from its original the first time either is edited.
   *
   * Resolved defensively: a missing parent is ignored and a cycle is broken, because neither should
   * be able to stop work running.
   */
  basedOn?: string;
  /** Where this persona belongs. Absent means anywhere — see PersonaScope. */
  scope?: PersonaScope;
  /** One line, shown in the picker — why you would choose this one. */
  description?: string;
  /**
   * Composed into the SINGLE system message, never appended as a second one.
   *
   * Chat templates reject more than one system message outright, and the failure is total. See
   * `buildOutboundMessages`, which exists to protect exactly this.
   */
  systemPrompt?: string;
  /** Validated against the tunable registry, like every other override bag. */
  overrides: Overrides;
  createdAt: string;
  updatedAt: string;
}

/* ── persona packs ────────────────────────────────────────────────────────── */

/**
 * Which executor dispatches a tool call.
 *
 * ── WHY THIS IS NOT THE TOOL LIST ──
 * It was, and the two do not belong together. `assistant` and `workbench` are not two sets of
 * tools; they are two FUNCTIONS with different arguments — `runKoalaTool` is scoped to a
 * conversation, `runLeafTool` to a branch, and koala-tool-runner.ts's docblock is explicit that
 * "the two share no vocabulary". Which tools a pack may call is a separate list, resolved against
 * the tool registry, because those are separate questions: one is dispatch, the other is grant.
 *
 * `sandbox` was a fourth value and is deliberately absent. A sandbox is the LEAF runtime — a pod
 * with a NetworkPolicy, created by `personaWorkspace` and run under Temporal over minutes. A chat
 * turn is one HTTP request holding a stream open. A conversation reaches sandboxed work by
 * proposing a leaf, never by becoming one.
 */
export type PackToolset = 'assistant' | 'workbench' | 'none';

/**
 * Everything about HOW something runs, as one editable record.
 *
 * ── WHY THIS IS SEPARATE FROM THE PERSONA ──
 * A persona is WHO: a name, a description, a prompt. A pack is HOW: the engine, the tools, the
 * sandbox shape, the budgets, what the surface renders. They were one record that claimed both
 * jobs and did neither completely — `PersonaScope` held the sandbox environment while a hardcoded
 * `PersonaPack` constant held the conversation environment, and five of that constant's six knobs
 * had no reader at all.
 *
 * The split is by MEANING, not by runtime: one pack answers "how is this run" for a chat turn and
 * for a leaf alike. That is why `leaf.packId` replaced `leaf.personaId` — a leaf run is the model
 * being run, so it is a pack that runs it.
 *
 * ── WHY THE KNOBS LIVE IN `overrides` AND NOT AS FIELDS ──
 * `tunables.ts` already provides registry validation, layered resolution and Lab variance for
 * every key in that bag. A field here would get none of those, and would have to grow each of them
 * by hand. Adding a knob is one registry entry; it is then editable and A/B-testable with no code.
 */
export interface PersonaPack {
  id: string;
  ownerId: string;
  /**
   * Stable, URL-safe identity — `#/chat/koala` rather than `#/chat/<uuid>`.
   *
   * Also what seeding matches on, so re-seeding recognises a pack the user has since renamed.
   * Unique per owner, for the same reason a persona's name is: the picker shows it, and two packs
   * answering to `koala` is a route you cannot resolve.
   */
  slug: string;
  /** Shown in the pack picker and the chat header. */
  name: string;
  description?: string;
  /**
   * The persona this pack runs as — its prompt and identity.
   *
   * An id rather than a name. Names are editable (`routes/personas.ts` PUT accepts one), so a name
   * handle silently re-points when somebody renames a persona in the UI. A pack whose persona has
   * been deleted REFUSES rather than substituting one: the previous behaviour resolved any unknown
   * name to Koala, so a pack could run as a persona nobody chose with nothing reporting it.
   */
  personaId: string;
  /** Which executor dispatches this pack's tool calls. */
  toolset: PackToolset;
  /**
   * Tools this pack may call, by registry name. Empty means every tool its executor offers.
   *
   * Resolved against the tool registry, so the same list decides the schemas sent to the model,
   * the guidance written into the prompt, and what the editor offers. Those were three disjoint
   * lists — 26 registry tools could not be granted through the UI at all, and the two web tools
   * had handlers with no schema, so no model was ever offered them.
   */
  tools: string[];
  /**
   * Which categories of action this pack may take, for the action gate.
   *
   * `action-gate.ts` has shipped `READ_ONLY` and `PROPOSE_ONLY` since it was written, and both
   * tool runners accept a `permitted` list — but no caller ever set one, so every conversation ran
   * with full write access regardless of what its pack claimed. This is that wire.
   */
  permitted: ToolEffect[];
  /** Every registered tunable this pack sets. Validated against `TUNABLES`, layered by `resolveConfig`. */
  overrides: Overrides;
  /** Ships with the platform. Seeded additively and never overwritten once edited. */
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a tool call DOES, for the action gate.
 *
 * Mirrored from `lib/action-gate.ts` so the frontend can render a pack's permissions without
 * importing backend code. ── DUPLICATED, KNOWINGLY ── `lib/action-gate.ts` is the authority; it
 * owns `ALL_EFFECTS` and the default-deny decision.
 */
export type ToolEffect = 'read' | 'write' | 'propose';

/* ── run outcomes ─────────────────────────────────────────────────────────── */

/**
 * What actually happened to one run, as opposed to whether it scored.
 *
 * ── WHY A BOOLEAN WAS NOT ENOUGH ──
 * `verified` collapses four different facts into one bit, and all four occurred in a single
 * afternoon: a run whose answer was wrong, a run that produced correct work and never declared it
 * done, a run the model server died underneath, and a run that passed. Scored identically, the
 * middle two are indistinguishable from incapability — which is how thirteen runs that never
 * executed were nearly read as a dramatic result, and how three arms hitting a step cap read as a
 * capability difference rather than a budget that was too low.
 */
export type RunOutcome =
  /** Verify passed. The only outcome that counts toward a score. */
  | 'verified'
  /** Ran to a conclusion and verify rejected the result. A real, attributable failure. */
  | 'wrong'
  /** Exhausted its step budget without finishing. The work may well be correct — check before reading it as failure. */
  | 'incomplete'
  /** Never got a fair attempt: no model, no sandbox, a timeout. Evidence about the harness, not the arm. */
  | 'broken';

/** How a variant's runs fell out, beside the score rather than folded into it. */
export interface OutcomeCounts {
  verified: number;
  wrong: number;
  incomplete: number;
  broken: number;
}

