
export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base';

export type ModelKind = 'vllm' | 'tabbyapi';

export interface AgentStep {
  step: number;
  reasoning?: string;
  content?: string;
  toolCalls: { name: string; arguments: string }[];
  toolResults: { name: string; result: string }[];
  tokens: number;
  truncated?: boolean;
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  name?: string;
  truncated?: boolean;
}

export interface AgentRequest {
  systemPrompt: string;
  kickoff: string;
  model?: string | undefined;
  tools: { name: string; description: string }[];
  parameters: Record<string, unknown>;
  overrides?: Overrides;
  unsupported?: string[];
  fromProfile?: string[];
  fromPersona?: string[];
  fromPack?: string[];
  /**
   * The pack this run was configured by, with its values copied in at the moment the run started.
   * A pack id alone would be a lie the first time the pack is edited.
   */
  ranAs?: {
    packId: string;
    slug: string;
    packUpdatedAt: string;
    sampling: SamplingConfig;
    budget: BudgetConfig;
  };
  loop?: { maxSteps: number; think: boolean; toolResultCap: number };
}

export type Overrides = Record<string, unknown>;

export type TunablePlacement = 'body' | 'template_vars' | 'loop';

export type TunableType = 'number' | 'boolean' | 'string' | 'enum';

export interface Tunable {
  key: string;
  label: string;
  group: 'sampling' | 'loop' | 'prompt';
  type: TunableType;
  placement: TunablePlacement;
  field?: string;
  engine?: ModelKind;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  choicesFrom?: 'models';
  settableAt?: ('profile' | 'persona' | 'pack' | 'request')[];
  choices?: { value: string; label: string; note?: string }[];
  /**
   * Optional because a sampler knob has no default here any more — the pack says what it is set to,
   * and this table only describes the knob. Present for the ones a pack does not carry.
   */
  default?: unknown;
  /**
   * The pack field this knob sets, as a dotted path. This is what makes a knob editable: the pack
   * editor and the Lab's axis picker write here, and a knob with no path is descriptive only.
   */
  path?: string;
  promptId?: string;
  suggested?: unknown[];
  note?: string;
  source: string;
}

export interface EffectiveKnob {
  key: string;
  label: string;
  group: Tunable['group'];
  value: unknown;
  source: 'harness' | 'adopted';
  note?: string;
  sourceFile: string;
}

export type ExperimentOverrides = Overrides & { language?: WorkspaceLanguage };

export interface ExperimentVariant {
  label: string;
  /**
   * The pack this arm runs as. Required: an arm varies a pack now, not a bag of overrides layered
   * under one. For an arm that changes a knob this is a derived pack (see `PersonaPack.derivedFrom`).
   */
  packId: string;
}

export interface TaskFile {
  path: string;
  content: string;
}

export interface ExperimentTask {
  id: string;
  name: string;
  prompt: string;
  verifyCommand: string;
  planning?: boolean;
  seed?: TaskFile[];
  solution?: TaskFile[];
  language?: WorkspaceLanguage;
}

export type ExperimentStatus = 'draft' | 'running' | 'complete' | 'failed';

export interface VariantResult {
  label: string;
  taskId?: string;
  succeeded: boolean;
  verified: boolean;
  verifyExitCode: number;
  verifyOutput: string;
  steps: number;
  tokensUsed: number;
  durationMs: number;
  summary: string;
  transcript: string[];
  request?: AgentRequest;
  conversation?: ConversationMessage[];
  expected?: { verifyCommand: string; note: string };
  trace?: AgentStep[];
  evidence?: { diff?: string; diffTruncated?: boolean };
  toolsUsed?: string[];
  usedDedicatedTool?: boolean;
  error?: string;
}

export interface ExperimentRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'failed';
  model?: string;
  profileOverrides?: Overrides;
  results: VariantResult[];
  progress?: string | undefined;
  error?: string | undefined;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'failed';
  model?: string;
  verified: number;
  runs: number;
  attempted: number;
  broken: number;
}

export interface Experiment {
  id: string;
  ownerId: string;
  name: string;
  runs?: ExperimentRun[];
  tasks?: ExperimentTask[];
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
  running?: boolean;
}

export interface ResultSummary {
  label: string;
  taskId: string;
  succeeded: boolean;
  verified: boolean;
  verifyExitCode: number;
  steps: number;
  tokensUsed: number;
  durationMs: number;
  toolsUsed?: string[];
  usedDedicatedTool?: boolean;
  error?: string;
}

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
  tasks: TaskSummary[];
  variants: ExperimentVariant[];
  repeats: number;
  status: ExperimentStatus;
  results: ResultSummary[];
  history: RunSummary[];
  progress?: string | undefined;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
}

export interface ExperimentRunStarted {
  experimentId: string;
  taskId: string;
  taskName: string;
  label: string;
  repeat: number;
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

export interface PromotionProvenance {
  experimentId: string;
  experimentName: string;
  variantLabel: string;
  verified: number;
  runs: number;
  tasks: number;
  wasBest: boolean;
  promotedAt: string;
}

export interface ProfileVersion {
  id: string;
  /** The pack this account was running as before the version that superseded it. */
  packId?: string;
  from?: PromotionProvenance;
  supersededAt: string;
}

export interface HarnessProfile {
  ownerId: string;
  /** Which pack this account runs as. The profile carries no values of its own any more. */
  packId?: string;
  from?: PromotionProvenance;
  history?: ProfileVersion[];
  updatedAt: string;
}

export interface PromotionStanding {
  label: string;
  verified: number;
  runs: number;
  attempted: number;
  broken: number;
  tasks: number;
  rank: number;
  wasBest: boolean;
  behindBy: number;
  medianTokens: number;
}

/** One pack value a promotion would overwrite, as a dotted path into the pack. */
export interface PackChange {
  path: string;
  from: unknown;
  to: unknown;
}

export interface HarnessSetting {
  label: string;
  value: string;
  note?: string;
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
  prompts: { id: string; title: string; text: string }[];
  languages: { id: WorkspaceLanguage; image: string; summary: string }[];
  models: { id: string; name: string; model: string; source: string; kind?: ModelKind }[];
  limits: {
    maxVariants: number;
    maxRepeats: number;
    maxTaskChars: number;
    maxTasks: number;
    maxTotalRuns: number;
  };
  tunables: Tunable[];
  effective: EffectiveKnob[];
}

export type PersonaEgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

export interface WorkspaceScope {
  language?: string;
  cpu?: string;
  memory?: string;
  env?: { name: string; value: string }[];
  repo?: boolean;
  output?: string;
  requireSources?: boolean;
  egress?: PersonaEgressRule[];
  run?: {
    maxSteps?: number;
    maxTokens?: number;
    withdraw?: { afterStep: number; tools: string[] };
    pacing?: { atRemaining: number; message: string }[];
  };
  tunedFor?: string;
}

export interface Persona {
  id: string;
  ownerId?: string;
  builtIn?: boolean;
  name: string;
  basedOn?: string;
  description?: string;
  systemPrompt?: string;
  createdAt: string;
  updatedAt: string;
}


/**
 * The sampler, stated per turn kind and per engine. Concrete values, not a diff: a pack that says
 * nothing used to still run at temperature 0.3 with a frequency penalty, decided in a module the
 * user cannot reach. `byEngine` is layered on top of the turn's values because a loop guard is a
 * property of the engine — TabbyAPI's DRY parameters mean nothing to an OpenAI endpoint.
 */
export interface SamplingConfig {
  toolTurn: Record<string, number | string | boolean>;
  conversation: Record<string, number | string | boolean>;
  byEngine?: Record<string, Record<string, number | string | boolean>>;
}

/**
 * What one run may spend, and what it is shown. Concrete values, not a diff — a pack that said
 * nothing still ran to a 800-token reply cap, 8 rounds and a 60,000-character conversation budget,
 * all decided in modules no user can reach.
 *
 * The three groups are not interchangeable. `replyTokens` and `rounds` decide what the model
 * PRODUCES; `toolResultChars`, `conversationChars` and `handoff` decide what it is SHOWN; `record`
 * decides only what is written down afterwards and never reaches the model at all.
 */
export interface BudgetConfig {
  replyTokens: {
    /** A turn whose job is to call a tool. */
    tool: number;
    /** A turn that is allowed to think first. */
    thinking: number;
    /** A turn that writes files, which needs room for the file. */
    writingFiles: number;
    /** A /plan turn. */
    plan: number;
    /** The most any single turn may be given, whatever the caller asks for. */
    ceiling: number;
  };
  /** Used when the endpoint does not report its own window. The endpoint wins when it does. */
  contextTokens: number;
  contextMargin: number;
  minReplyTokens: number;
  /** Rounds of tool calling within one turn. */
  rounds: number;
  proposalsPerReply: number;
  toolResultChars: number;
  conversationChars: number;
  conversationGrowth: number;
  messageChars: number;
  run: { steps: number; tokens: number; researchSteps: number; wrapUpSteps: number };
  handoff: {
    /** Fraction of the context window at which a conversation is handed off rather than continued. */
    at: number;
    tail: number;
    reasoningKept: number;
    goalChars: number;
    discoveryChars: number;
    discoveries: number;
    listedProposals: number;
  };
  record: {
    callsPerRound: number;
    argChars: number;
    digestChars: number;
    traceReasoning: number;
    traceContent: number;
    traceToolResult: number;
    traceToolArgs: number;
  };
}

/**
 * Everything wrapped around a persona's own prompt, and the thresholds that reshape it.
 *
 * Sections are templates: `{{name}}` is filled at compose time. Only the escalated-role block and
 * the pressure notice take a value today, but the placeholders are what let a user rewrite a
 * section without losing the one piece the harness has to supply.
 *
 * A section set to an empty string is not emitted at all, which is how a pack turns one off.
 */
export interface PromptConfig {
  /**
   * Fractions of the context window at which the prompt changes shape. `compactAt` drops usage
   * guidance, `minimalAt` drops to one phrase per tool, `noticeAt` appends the notice. They are
   * independent: the notice sits between the two tool thresholds and is meant to.
   */
  pressure: { compactAt: number; minimalAt: number; noticeAt: number };
  sections: {
    /** Exactly one of these three is emitted, in this order of precedence. */
    role: { admin: string; escalated: string; standard: string };
    /** Emitted when the pack grants a secrets tool. */
    secrets: string;
    /** The heading above the active tool list. */
    toolGuidance: string;
    services: { none: string; heading: string };
    memories: string;
    pressureNotice: string;
    /** Injected by a planning turn, beside the persona's prompt. */
    toolDiscipline: string;
  };
}

export interface PersonaPack {
  id: string;
  ownerId?: string;
  slug: string;
  name: string;
  description?: string;
  personaId: string;
  basedOn?: string;
  tools: string[];
  mcp?: string[];
  workspace?: WorkspaceScope;
  sampling: SamplingConfig;
  budget: BudgetConfig;
  prompt: PromptConfig;
  /**
   * Which engine this pack runs on. `endpointId` is a provider id from the owner's own list, so it
   * is empty on a shipped pack — the platform ships no endpoints. Empty means the caller must name
   * one; nothing named anywhere is an error rather than whichever endpoint was listed first.
   */
  model?: { endpointId?: string };
  /**
   * Set when this pack is one experiment arm's copy of another pack. Such a pack is scoped to its
   * experiment and hidden from the user's pack list — an arm has to be a pack now that a variant
   * varies a pack, and without this a five-arm experiment would leave five near-duplicates behind.
   */
  derivedFrom?: { packId: string; experimentId: string; label: string };

  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ToolEffect = 'read' | 'write' | 'propose';

export type RunOutcome =
  | 'verified'
  | 'wrong'
  | 'incomplete'
  | 'broken';

export interface OutcomeCounts {
  verified: number;
  wrong: number;
  incomplete: number;
  broken: number;
}
