export type SocketType = 'text' | 'messages' | 'reply' | 'toolCalls' | 'toolResults' | 'toolSet' | 'environment' | 'memory' | 'persona' | 'modelBinding' | 'json' | 'any'

export interface Out<T extends SocketType> {
  readonly __carries: T
}

export type In<T extends SocketType> = T extends 'any' ? Out<SocketType> : Out<T> | Out<'any'>

export interface ExitTarget {
  readonly __leavesTheGroup: true
}

export interface Step<E extends string> {
  readonly id: string
  on(exit: E, to: Step<string> | ExitTarget): void
}

export interface Value {
  readonly id: string
}

export interface NodeMeta {
  label?: string
  notes?: string
}

export type Layout = Readonly<Record<string, readonly [number, number]>>

export interface GroupSocket {
  type: SocketType
  describe: string
  required?: boolean
  many?: boolean
}

export interface GroupExitInfo {
  describe: string
}

export type Sockets = Readonly<Record<string, GroupSocket>>

export type Exits = Readonly<Record<string, GroupExitInfo>>

export interface GroupInfo<I extends Sockets, O extends Sockets, E extends Exits> {
  title: string
  describe: string
  inputs?: I
  outputs?: O
  exits?: E
}

export interface GroupRef<I extends Sockets, O extends Sockets, E extends Exits> {
  readonly __group: [I, O, E]
}

export type GroupWires<I extends Sockets> = { [K in keyof I]?: In<I[K]['type']> | readonly In<I[K]['type']>[] }

export type GroupNode<I extends Sockets, O extends Sockets, E extends Exits> = Step<Extract<keyof E, string>> & { readonly [K in keyof O]: Out<O[K]['type']> } & { wire(wires: GroupWires<I>): void }

export interface BuildContextWires {
  /** The sections, top to bottom. Required. Takes any number of wires. */
  sections?: In<'text'> | readonly In<'text'>[]
}

export type BuildContextSettings = Record<string, never>

export interface BuildContextNode extends Value {
  /** The system prompt. */
  readonly text: Out<'text'>
  wire(wires: BuildContextWires): void
}

export type CodeWires = Record<string, In<SocketType> | readonly In<SocketType>[]>

export type CodeSettings = {
  /**
   * Body
   * JavaScript. It is given "inputs" and returns an object with the values it declares. Top-level await works.
   */
  body: string
  /**
   * Values it takes
   * Each one becomes a socket you can wire into, and a key on "inputs".
   */
  inputs?: readonly ({
    /** Name */
    name?: string
    /** Kind */
    type?: 'text' | 'messages' | 'reply' | 'toolCalls' | 'toolResults' | 'toolSet' | 'environment' | 'memory' | 'persona' | 'modelBinding' | 'json' | 'any'
    /** What it is */
    describe?: string
  })[]
  /**
   * Values it hands back
   * Each one becomes a socket you can wire out of, and a key on what the body returns.
   */
  outputs?: readonly ({
    /** Name */
    name?: string
    /** Kind */
    type?: 'text' | 'messages' | 'reply' | 'toolCalls' | 'toolResults' | 'toolSet' | 'environment' | 'memory' | 'persona' | 'modelBinding' | 'json' | 'any'
    /** What it is */
    describe?: string
  })[]
  /**
   * Give up after
   * Milliseconds before the body is stopped.
   */
  timeoutMs?: number
}

export type CodeNode = Value & Record<string, Out<SocketType>> & { wire(wires: CodeWires): void }

export interface ConversationWires {
  /** The first user message. Required. */
  opening?: In<'text'>
  /** The named inputs the run was started with. Each one the opening does not already say is added to it, labelled, so the model sees everything the run was given. */
  given?: In<'json'>
  /** What was said in earlier runs. Wired from Load Conversation, it goes in front of the opening so the model sees the whole thread. Nothing wired means the conversation starts here. */
  history?: In<'messages'>
  /** The model's replies, from any number of model steps. Takes any number of wires. */
  replies?: In<'reply'> | readonly In<'reply'>[]
  /** Tool results, including refusals, from any number of steps. Takes any number of wires. */
  results?: In<'toolResults'> | readonly In<'toolResults'>[]
}

export type ConversationSettings = Record<string, never>

export interface ConversationNode extends Step<'done'> {
  /** The conversation so far. */
  readonly messages: Out<'messages'>
  /** Every model round the conversation has seen, each with its own reply and the tool results it drew back — the shape of a multi-round turn, so a save can remember the calls made in the middle of it, not only the final words. */
  readonly rounds: Out<'json'>
  wire(wires: ConversationWires): void
}

export interface DescribeEnvironmentWires {
  /** What the run can reach. Nothing wired means no environment. */
  environment?: In<'environment'>
  /** The personas it may delegate to. */
  delegates?: In<'json'>
}

export type DescribeEnvironmentSettings = Record<string, never>

export interface DescribeEnvironmentNode extends Value {
  /** The environment section of the prompt. */
  readonly text: Out<'text'>
  wire(wires: DescribeEnvironmentWires): void
}

export interface DescribeOutputsWires {
  /** Whose declared outputs to ask for. Required. */
  persona?: In<'persona'>
}

export type DescribeOutputsSettings = Record<string, never>

export interface DescribeOutputsNode extends Value {
  /** The outputs section of the prompt, or nothing if none are declared. */
  readonly text: Out<'text'>
  wire(wires: DescribeOutputsWires): void
}

export type DescribeProcedureWires = Record<string, never>

export type DescribeProcedureSettings = Record<string, never>

export interface DescribeProcedureNode extends Value {
  /** The section naming what happens around the model. */
  readonly text: Out<'text'>
  wire(wires: DescribeProcedureWires): void
}

export interface DescribeToolsWires {
  /** The tools being offered. */
  offered?: In<'toolSet'>
  /** The tools not offered, with reasons. */
  withheld?: In<'json'>
  /** Decides what the model is told about reaching the network. */
  environment?: In<'environment'>
}

export type DescribeToolsSettings = Record<string, never>

export interface DescribeToolsNode extends Value {
  /** The tools section of the prompt. */
  readonly text: Out<'text'>
  wire(wires: DescribeToolsWires): void
}

export interface HandOffConversationWires {
  /** The full history. Required. */
  messages?: In<'messages'>
  /** The model, for its context window. Required. */
  binding?: In<'modelBinding'>
  /** The system prompt, which also takes up the window. */
  system?: In<'text'>
}

export type HandOffConversationSettings = {
  /**
   * Hand off at
   * How full the window may get, from 0 to 1.
   */
  at?: number
  /** Messages kept */
  tail?: number
  /** Goal length */
  goalChars?: number
  /** Findings kept */
  discoveries?: number
  /** Finding length */
  discoveryChars?: number
}

export interface HandOffConversationNode extends Step<'fits' | 'handedOff'> {
  /** The history to send. */
  readonly messages: Out<'messages'>
  wire(wires: HandOffConversationWires): void
}

export interface LoadConversationWires {
  /** Values the id can refer to as {{values.…}}. */
  values?: In<'json'>
}

export type LoadConversationSettings = {
  /**
   * Conversation
   * Which conversation, written as a template over the run's inputs — for example {{values.conversationId}}.
   */
  id: string
}

export interface LoadConversationNode extends Value {
  /** What was said before, oldest first. */
  readonly messages: Out<'messages'>
  /** Whether a stored conversation was there to read. */
  readonly found: Out<'json'>
  wire(wires: LoadConversationWires): void
}

export interface ResolveToolsWires {
  /** Whose grants to start from. Required. */
  persona?: In<'persona'>
  /** The personas it may delegate to, offered as tools. */
  delegates?: In<'json'>
  /** What the run can reach. Nothing wired means no environment. */
  environment?: In<'environment'>
}

export type ResolveToolsSettings = {
  /**
   * Offer
   * "granted" offers everything that works here, "none" offers nothing, "chosen" offers only the tools listed below.
   */
  offer?: 'granted' | 'none' | 'chosen'
  /**
   * Chosen tools
   * Used when Offer is "chosen".
   */
  chosen?: readonly (string)[]
}

export interface ResolveToolsNode extends Value {
  /** The tools to offer the model. */
  readonly offered: Out<'toolSet'>
  /** Granted tools that are not offered, each with why. */
  readonly withheld: Out<'json'>
  wire(wires: ResolveToolsWires): void
}

export interface SaveConversationWires {
  /** Values the id can refer to as {{values.…}}. */
  values?: In<'json'>
  /** What the person said this turn. Required. */
  asked?: In<'text'>
  /** The model's answer. A turn that was cut short hands back what it had, and that is what gets written. */
  reply?: In<'reply'>
  /** What the tools it called gave back, including refusals. Takes any number of wires. */
  results?: In<'toolResults'> | readonly In<'toolResults'>[]
  /** The rounds the Conversation node accumulated, each a reply with the results its calls drew back. They carry the calls made in the middle of a multi-round turn, which the reply and results inputs, being the latest, cannot. */
  rounds?: In<'json'>
}

export type SaveConversationSettings = {
  /**
   * Conversation
   * Which conversation, written as a template over the run's inputs — for example {{values.conversationId}}.
   */
  id: string
  /**
   * Title when it is new
   * Used only when the conversation is being created. Blank means it is named after the first thing asked.
   */
  title?: string
}

export interface SaveConversationNode extends Step<'saved' | 'failed'> {
  /** The conversation that was written. */
  readonly conversation: Out<'text'>
  wire(wires: SaveConversationWires): void
}

export type TextWires = Record<string, never>

export type TextSettings = {
  /** Text */
  text?: string
}

export interface TextNode extends Value {
  /** The text as written. */
  readonly text: Out<'text'>
  wire(wires: TextWires): void
}

export interface TrimToolResultsWires {
  /** The full results. Required. */
  results?: In<'toolResults'>
}

export type TrimToolResultsSettings = {
  /** Characters kept */
  maxChars?: number
}

export interface TrimToolResultsNode extends Value {
  /** The results as the model will see them. */
  readonly results: Out<'toolResults'>
  wire(wires: TrimToolResultsWires): void
}

export interface TruncateTextWires {
  /** The text to cap. Required. */
  text?: In<'text'>
}

export type TruncateTextSettings = {
  /** Characters kept */
  maxChars?: number
  /**
   * Keep
   * "start" keeps the beginning, where something usually says what it is; "end" keeps the last of it, where an error or a total usually is.
   */
  keep?: 'start' | 'end'
}

export interface TruncateTextNode extends Value {
  /** The text, capped, with a note saying how much was cut when any was. */
  readonly text: Out<'text'>
  wire(wires: TruncateTextWires): void
}

export type WarnRunningOutWires = Record<string, never>

export type WarnRunningOutSettings = {
  /**
   * Notes
   * Each note applies once this many rounds or fewer are left.
   */
  notes: readonly ({
    /** Rounds left */
    atRemaining: number
    /** Message */
    message: string
  })[]
}

export interface WarnRunningOutNode extends Value {
  /** The note, or nothing while there is time. */
  readonly text: Out<'text'>
  wire(wires: WarnRunningOutWires): void
}

export interface WithdrawToolsWires {
  /** The tools that would otherwise be offered. Required. */
  tools?: In<'toolSet'>
}

export type WithdrawToolsSettings = {
  /**
   * After round
   * Withdraw from this round on.
   */
  afterRound: number
  /**
   * Tools
   * Which tools to take away.
   */
  tools: readonly (string)[]
}

export interface WithdrawToolsNode extends Value {
  /** The tools still offered. */
  readonly tools: Out<'toolSet'>
  /** The names taken away this round, if any. */
  readonly withdrawn: Out<'json'>
  wire(wires: WithdrawToolsWires): void
}

export interface CollectWires {
  /** What to add this time. Required. */
  item?: In<'any'>
}

export type CollectSettings = {
  /**
   * Add a list's contents
   * When the value is a list, add each thing in it rather than the list itself.
   */
  spread?: boolean
}

export interface CollectNode extends Step<'done'> {
  /** Everything collected so far, oldest first. */
  readonly items: Out<'json'>
  wire(wires: CollectWires): void
}

export interface ConditionWires {
  /** What the expression reads as "value". */
  value?: In<'any'>
}

export type ConditionSettings = {
  /**
   * Expression
   * For example: not empty(value) and counters.rounds < 5
   */
  expression: string
}

export interface ConditionNode extends Step<'true' | 'false'> {
  wire(wires: ConditionWires): void
}

export interface DelegateWires {
  /** Values the inputs can refer to as {{values.…}}. */
  values?: In<'json'>
  /** Text the inputs can refer to as {{text}}. */
  text?: In<'text'>
  /** A workspace to hand the child, so it works where the work was done rather than somewhere of its own. Nothing wired means it gets its own. */
  environment?: In<'environment'>
}

export type DelegateSettings = {
  /** Persona */
  agent: string
  /**
   * Inputs
   * Inputs are JSON. {{values.name}} is replaced with that part of the wired values, and {{text}} with the wired text.
   */
  inputs?: string
  /**
   * The model may also choose this
   * By default this step is the procedure's job: the model is not offered this persona and is told the procedure hands the work over. Tick this to offer it to the model as well.
   */
  shared?: boolean
  /**
   * What the model is told
   * One line explaining what this step does for it, such as "A judge weighs your work when you finish." Ignored when the model may also choose it.
   */
  says?: string
}

export interface DelegateNode extends Step<'ok' | 'failed'> {
  /** What the child run handed back. */
  readonly outputs: Out<'json'>
  /** What the child handed back, as text: its result when that is text, otherwise the whole thing as JSON. */
  readonly text: Out<'text'>
  /** Why the child did not finish, when it did not. */
  readonly reason: Out<'text'>
  wire(wires: DelegateWires): void
}

export interface FanOutWires {
  /** The list to fan out over. Required. */
  items?: In<'json'>
}

export type FanOutSettings = {
  /** Persona */
  agent: string
  /** At a time */
  maxParallel?: number
}

export interface FanOutNode extends Step<'done'> {
  /** Every child's outcome, in list order. */
  readonly children: Out<'json'>
  wire(wires: FanOutWires): void
}

export interface FinishWires {
  /** Why the run ended. Replaces the written reason when wired. */
  reason?: In<'text'>
  /** What the run hands back. */
  result?: In<'any'>
}

export type FinishSettings = {
  /** Outcome */
  outcome: 'ok' | 'failed' | 'refused'
  /** Reason */
  reason?: string
}

export interface FinishNode extends Step<never> {
  /** What the run hands back. */
  readonly result: Out<'any'>
  wire(wires: FinishWires): void
}

export interface MergeWires {
  /** The outcomes to reduce. Required. */
  children?: In<'json'>
}

export type MergeSettings = {
  /** Keep */
  strategy?: 'all' | 'ok' | 'first-ok' | 'failed'
}

export interface MergeNode extends Step<'done'> {
  /** The outcomes kept. */
  readonly merged: Out<'json'>
  wire(wires: MergeWires): void
}

export interface WaitForPersonWires {
  /** Shown under the message — for example the plan the person is asked to review. */
  details?: In<'text'>
}

export type WaitForPersonSettings = {
  /** Message */
  prompt: string
  /** Wait for (minutes) */
  timeoutMinutes?: number
}

export interface WaitForPersonNode extends Step<'answered' | 'unanswered'> {
  /** What the person answered. */
  readonly answer: Out<'any'>
  /** Why there was no answer, when there was none. */
  readonly reason: Out<'text'>
  wire(wires: WaitForPersonWires): void
}

export type ProvisionSandboxWires = Record<string, never>

export type ProvisionSandboxSettings = Record<string, never>

export interface ProvisionSandboxNode extends Step<'ready' | 'unavailable'> {
  /** Where the run is working. */
  readonly environment: Out<'environment'>
  /** Why no environment could be provided, when none could. */
  readonly reason: Out<'text'>
  wire(wires: ProvisionSandboxWires): void
}

export interface ReleaseSandboxWires {
  /** The environment to release. */
  environment?: In<'environment'>
}

export type ReleaseSandboxSettings = Record<string, never>

export interface ReleaseSandboxNode extends Step<'done'> {
  wire(wires: ReleaseSandboxWires): void
}

export type PersonaWires = Record<string, never>

export type PersonaSettings = Record<string, never>

export interface PersonaNode extends Value {
  /** The whole persona record. */
  readonly persona: Out<'persona'>
  /** The persona's own prompt, trimmed. */
  readonly prompt: Out<'text'>
  /** The personas this one may delegate to. */
  readonly delegates: Out<'json'>
  wire(wires: PersonaWires): void
}

export type RunInputWires = Record<string, never>

export type RunInputSettings = Record<string, never>

export interface RunInputNode extends Value {
  /** The message the run was started with. */
  readonly message: Out<'text'>
  /** The named inputs the run was started with. */
  readonly inputs: Out<'json'>
  wire(wires: RunInputWires): void
}

export type RecallMemoryWires = Record<string, never>

export type RecallMemorySettings = {
  /**
   * Scope
   * "project" only recalls memories for the run's project; "global" only the ones that apply everywhere.
   */
  scope?: 'all' | 'project' | 'global'
  /** Characters */
  maxChars?: number
}

export interface RecallMemoryNode extends Value {
  /** The memories picked. */
  readonly memories: Out<'memory'>
  /** The memory section of the prompt, or nothing if there are none. */
  readonly text: Out<'text'>
  wire(wires: RecallMemoryWires): void
}

export interface SaveMemoryWires {
  /** What to remember. Required. */
  text?: In<'text'>
  /** A short name for it. Nothing wired means the first line of the text. */
  title?: In<'text'>
}

export type SaveMemorySettings = {
  /** Category */
  category?: 'lessons_learned' | 'environment_facts' | 'prompt_guidance'
  /** Scope */
  scope?: 'global' | 'project'
}

export interface SaveMemoryNode extends Step<'saved' | 'refused'> {
  /** The memory as saved. */
  readonly memory: Out<'json'>
  wire(wires: SaveMemoryWires): void
}

export interface CallModelWires {
  /** Which model to call and how. Required. */
  binding?: In<'modelBinding'>
  /** The system prompt. Required. */
  system?: In<'text'>
  /** The conversation so far. Required. */
  messages?: In<'messages'>
  /** The tools to offer. Nothing wired means none. */
  tools?: In<'toolSet'>
  /** The reply cap. Nothing wired means the binding's ceiling. */
  maxTokens?: In<'json'>
}

export type CallModelSettings = {
  /**
   * Tool choice
   * "none" sends the tools for reference but tells the model not to call any.
   */
  toolChoice?: 'auto' | 'none'
  /**
   * Reasoning effort
   * For models that support it. Leave empty for the model's default.
   */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /**
   * Stop overthinking
   * Cut the stream off when its thinking starts going in circles. This has to happen mid-stream, which is why it is a setting rather than a node after the call.
   */
  stopOverthinking?: boolean
}

export interface CallModelNode extends Step<'toolCalls' | 'answered' | 'truncated' | 'empty'> {
  /** The whole reply: content, thinking, tool calls and why it stopped. */
  readonly reply: Out<'reply'>
  /** Just the tool calls it asked for. */
  readonly toolCalls: Out<'toolCalls'>
  /** Just what it said. */
  readonly content: Out<'text'>
  wire(wires: CallModelWires): void
}

export interface ChooseModelWires {
  /** The persona whose model and sampling apply unless overridden. Required. */
  persona?: In<'persona'>
}

export type ChooseModelSettings = {
  /**
   * Model
   * Leave empty to use the model the run was started with, then the persona's, then the account default.
   */
  modelId?: string
  /**
   * Reply ceiling
   * The most tokens a reply may use. Leave it empty to let the model use whatever the context window has room for until its track record says what it typically needs.
   */
  replyCeiling?: number
  /**
   * Temperature
   * Leave empty to use the persona's sampling.
   */
  temperature?: number
}

export interface ChooseModelNode extends Value {
  /** Which model to call and how. */
  readonly binding: Out<'modelBinding'>
  wire(wires: ChooseModelWires): void
}

export interface DecideWires {
  /** Which model decides. Required. */
  binding?: In<'modelBinding'>
  /** What the question is about. Anything that is not text is shown to the model as JSON. Required. */
  text?: In<'any'>
}

export type DecideSettings = {
  /**
   * Question
   * A question that can be answered yes or no from the text alone.
   */
  question: string
}

export interface DecideNode extends Step<'yes' | 'no' | 'unsure'> {
  /** yes, no or unsure. */
  readonly decision: Out<'text'>
  /** The model's whole answer, including why it decided that. */
  readonly why: Out<'text'>
  wire(wires: DecideWires): void
}

export interface FitReplyBudgetWires {
  /** The model, for its context window and reply ceiling. Required. */
  binding?: In<'modelBinding'>
  /** The system prompt that will be sent. Required. */
  system?: In<'text'>
  /** The conversation that will be sent. */
  messages?: In<'messages'>
}

export type FitReplyBudgetSettings = {
  /**
   * Safety margin
   * Tokens kept free on top of the prompt, because the character count only estimates tokens.
   */
  marginTokens?: number
  /**
   * Smallest reply
   * Never cap a reply below this, even when the window is nearly full.
   */
  minReplyTokens?: number
}

export interface FitReplyBudgetNode extends Value {
  /** The reply cap to call the model with. */
  readonly maxTokens: Out<'json'>
  /** How full the context window is, from 0 to 1. */
  readonly pressure: Out<'json'>
  wire(wires: FitReplyBudgetWires): void
}

export interface CheckRepetitionWires {
  /** The latest reply. Required. */
  reply?: In<'reply'>
}

export type CheckRepetitionSettings = {
  /**
   * Watch from round
   * Do not judge before this many turns.
   */
  minRounds?: number
}

export interface CheckRepetitionNode extends Step<'ok' | 'tripped'> {
  /** What the check saw when it tripped. */
  readonly reason: Out<'text'>
  wire(wires: CheckRepetitionWires): void
}

export interface CheckStallWires {
  /** The latest reply. Required. */
  reply?: In<'reply'>
}

export type CheckStallSettings = {
  /** Silent replies allowed */
  maxSilentRounds?: number
}

export interface CheckStallNode extends Step<'ok' | 'tripped'> {
  /** What the check saw when it tripped. */
  readonly reason: Out<'text'>
  wire(wires: CheckStallWires): void
}

export interface CheckToolFailuresWires {
  /** The latest tool results. Required. */
  results?: In<'toolResults'>
}

export type CheckToolFailuresSettings = {
  /** Failures in a row allowed */
  maxConsecutiveFailures?: number
}

export interface CheckToolFailuresNode extends Step<'ok' | 'tripped'> {
  /** What the check saw when it tripped. */
  readonly reason: Out<'text'>
  wire(wires: CheckToolFailuresWires): void
}

export interface ApproveToolCallsWires {
  /** The reply whose tool calls need approving. Required. */
  reply?: In<'reply'>
  /** Where the calls would run. */
  environment?: In<'environment'>
}

export type ApproveToolCallsSettings = {
  /**
   * Ask
   * "on-a-machine" asks only for a registered machine, "always" asks for every call, "never" lets everything through.
   */
  ask?: 'on-a-machine' | 'always' | 'never'
}

export interface ApproveToolCallsNode extends Step<'approved' | 'refused'> {
  /** The reply with only the approved calls left in it. */
  readonly approved: Out<'reply'>
  /** A result for each refused call. */
  readonly refused: Out<'toolResults'>
  wire(wires: ApproveToolCallsWires): void
}

export interface CallToolWires {
  /** Values the arguments can refer to as {{values.…}}. */
  values?: In<'json'>
  /** Text the arguments can refer to as {{text}}. */
  text?: In<'text'>
  /** Whose grants decide whether the tool may run. Required. */
  persona?: In<'persona'>
  /** Where an environment tool runs. */
  environment?: In<'environment'>
}

export type CallToolSettings = {
  /** Tool */
  tool: string
  /**
   * Arguments
   * Arguments are JSON. {{values.name}} is replaced with that part of the wired values, and {{text}} with the wired text.
   */
  args?: string
  /**
   * The model may also choose this
   * By default this step is the procedure's job: the model is not offered the tool and is told the procedure calls it. Tick this to offer it to the model as well.
   */
  shared?: boolean
  /**
   * What the model is told
   * One line explaining what this step does for it, such as "The task has already been claimed for you." Ignored when the model may also choose it.
   */
  says?: string
}

export interface CallToolNode extends Step<'ok' | 'failed'> {
  /** What the tool returned, parsed as JSON when it is JSON. */
  readonly result: Out<'json'>
  /** What the tool returned, as text. */
  readonly text: Out<'text'>
  wire(wires: CallToolWires): void
}

export interface RunToolCallsWires {
  /** The reply whose tool calls to run. Required. */
  reply?: In<'reply'>
  /** Whose grants and delegates decide what may run. Required. */
  persona?: In<'persona'>
  /** Where environment tools run. Nothing wired means no environment. */
  environment?: In<'environment'>
}

export type RunToolCallsSettings = {
  /**
   * Digest length
   * How much of each result is kept as its short digest for traces and monitors.
   */
  digestChars?: number
}

export interface RunToolCallsNode extends Step<'done'> {
  /** One result per call, in the order they were asked for. */
  readonly results: Out<'toolResults'>
  wire(wires: RunToolCallsWires): void
}

export interface ModelTurnGroupWires {
  /** The conversation to send. Required. */
  messages?: In<'messages'>
  /** Where the run is working. Nothing wired means no environment. */
  environment?: In<'environment'>
}

export interface ModelTurnGroupNode extends Step<'toolCalls' | 'answered' | 'truncated' | 'empty'> {
  /** The model's reply. */
  readonly reply: Out<'reply'>
  /** Just what the model said. */
  readonly content: Out<'text'>
  /** The persona the turn was for. */
  readonly persona: Out<'persona'>
  /** The model that was called. */
  readonly binding: Out<'modelBinding'>
  /** The system prompt that was sent. */
  readonly system: Out<'text'>
  wire(wires: ModelTurnGroupWires): void
}

export interface ToolLoopGroupWires {
  /** The reply whose tool calls to run. Required. */
  reply?: In<'reply'>
  /** Whose grants and delegates decide what may run. Required. */
  persona?: In<'persona'>
  /** Where environment tools run. */
  environment?: In<'environment'>
}

export interface ToolLoopGroupNode extends Step<'done' | 'refused' | 'failing'> {
  /** The results of the calls that ran, trimmed. */
  readonly results: Out<'toolResults'>
  /** A result for each call that was refused. */
  readonly refused: Out<'toolResults'>
  /** Why it stopped, when it did. */
  readonly reason: Out<'text'>
  wire(wires: ToolLoopGroupWires): void
}

export interface Nodes {
  /** Build Context: Joins sections into the system prompt, in the order they are wired, leaving out any that are empty. */
  buildContext(id: string, wires?: BuildContextWires, settings?: BuildContextSettings, meta?: NodeMeta): BuildContextNode
  /** Code: Runs a piece of JavaScript you wrote, in this run's own sandbox, with the values you wire in and the values you declare it hands back. The body is never read as a procedure — it is written out and executed there, so it can do anything the sandbox can, and nothing it cannot. */
  code(id: string, wires: CodeWires, settings: CodeSettings, meta?: NodeMeta): CodeNode
  /**
   * Conversation: Keeps the message history. It starts from whatever earlier thread is wired in, then the opening message and whatever named inputs the run was given that the opening does not already say; each time it runs it adds any new replies in the order they were made, each with the tool calls it asked for, and once every call in a reply has a result it adds those results, answering each call by id. Nothing is added twice.
   * Leaves through done: Always.
   */
  conversation(id: string, wires?: ConversationWires, settings?: ConversationSettings, meta?: NodeMeta): ConversationNode
  /** Describe Environment: Tells the model where it is working: a sandbox and its workspace, a registered machine, or no environment at all — and, when it has none, which bases its delegates could work in. */
  describeEnvironment(id: string, wires?: DescribeEnvironmentWires, settings?: DescribeEnvironmentSettings, meta?: NodeMeta): DescribeEnvironmentNode
  /** Describe Outputs: Tells the model what its final answer has to contain, from the outputs the persona declares. */
  describeOutputs(id: string, wires?: DescribeOutputsWires, settings?: DescribeOutputsSettings, meta?: NodeMeta): DescribeOutputsNode
  /** Describe Procedure: Tells the model which steps the procedure carries out for it, so it does not do them again. Reads every Call Tool step marked as the procedure's job. */
  describeProcedure(id: string, wires?: DescribeProcedureWires, settings?: DescribeProcedureSettings, meta?: NodeMeta): DescribeProcedureNode
  /** Describe Tools: Lists the tools the model can use right now with their guidance, the ones it cannot and why, and what to do when it cannot proceed. */
  describeTools(id: string, wires?: DescribeToolsWires, settings?: DescribeToolsSettings, meta?: NodeMeta): DescribeToolsNode
  /**
   * Hand Off Conversation: When the prompt fills the context window past a threshold, replaces the history with a summary — what the conversation is about and what the tools found — plus the last few messages. Otherwise passes the history through.
   * Leaves through fits: The history fits and was passed through.
   * Leaves through handedOff: The history was replaced with a summary and a tail.
   */
  handOffConversation(id: string, wires?: HandOffConversationWires, settings?: HandOffConversationSettings, meta?: NodeMeta): HandOffConversationNode
  /** Load Conversation: Reads a stored conversation and hands back what was said, so a run carries on where the last one stopped rather than starting cold. Nothing stored yet means an empty history, not a failure. */
  loadConversation(id: string, wires: LoadConversationWires, settings: LoadConversationSettings, meta?: NodeMeta): LoadConversationNode
  /** Resolve Tools: Works out which tools the model can use on this call: what the persona is granted, including the personas it may delegate to, narrowed to what the environment can support and what this step allows. Everything left out is listed with the reason. */
  resolveTools(id: string, wires?: ResolveToolsWires, settings?: ResolveToolsSettings, meta?: NodeMeta): ResolveToolsNode
  /**
   * Save Conversation: Appends this turn to the stored conversation: what the person asked, what the model answered, what it was thinking and which tools it called. A conversation that does not exist yet is created. A retry of the same save finds the turn already written and does not append it again. Put it in the cleanup lane and a turn that was stopped part way is still recorded, rather than vanishing.
   * Leaves through saved: The turn was appended.
   * Leaves through failed: It could not be written.
   */
  saveConversation(id: string, wires: SaveConversationWires, settings: SaveConversationSettings, meta?: NodeMeta): SaveConversationNode
  /** Text: A piece of text you write, to put anywhere text is taken — usually a section of the system prompt. */
  text(id: string, wires?: TextWires, settings?: TextSettings, meta?: NodeMeta): TextNode
  /** Trim Tool Results: Caps how much of each tool result the model sees, and says how much was cut. It keeps the end of ordinary output, where errors and totals usually are, and the start of anything structured, where a JSON result says what it is. */
  trimToolResults(id: string, wires?: TrimToolResultsWires, settings?: TrimToolResultsSettings, meta?: NodeMeta): TrimToolResultsNode
  /** Truncate Text: Caps a piece of text at a number of characters and says how much was cut, so one long thing cannot crowd everything else out of the prompt. */
  truncateText(id: string, wires?: TruncateTextWires, settings?: TruncateTextSettings, meta?: NodeMeta): TruncateTextNode
  /** Warn Running Out: Adds a note when the run is close to its round budget, so the model wraps up instead of being cut off mid-task. The note with the fewest rounds that still applies wins. */
  warnRunningOut(id: string, wires: WarnRunningOutWires, settings: WarnRunningOutSettings, meta?: NodeMeta): WarnRunningOutNode
  /** Withdraw Tools: Stops offering some tools once the run has used a number of rounds — for example taking away search once it is time to write up. */
  withdrawTools(id: string, wires: WithdrawToolsWires, settings: WithdrawToolsSettings, meta?: NodeMeta): WithdrawToolsNode
  /**
   * Collect: Adds the wired value to a list each time it runs, so a loop can gather every result instead of only the last.
   * Leaves through done: Always.
   */
  collect(id: string, wires?: CollectWires, settings?: CollectSettings, meta?: NodeMeta): CollectNode
  /**
   * Condition: Checks an expression and leaves through true or false. The expression can read the wired value as "value", the run's counters as "counters" (rounds, toolCalls, totalTokens…) and its inputs as "inputs". Functions: len, empty, contains, startsWith, endsWith, matches.
   * Leaves through true: The expression held.
   * Leaves through false: It did not.
   */
  condition(id: string, wires: ConditionWires, settings: ConditionSettings, meta?: NodeMeta): ConditionNode
  /**
   * Delegate: Starts another persona as a child run with the inputs you write, waits for it to finish, and leaves by how it ended. The child gets nothing except those inputs, unless you wire it an environment — then it works in that same workspace instead of one of its own, so it can see what was done there. Inputs are JSON. {{values.name}} is replaced with that part of the wired values, and {{text}} with the wired text.
   * Leaves through ok: The child finished ok.
   * Leaves through failed: The child failed, ran out of budget or was stopped.
   */
  delegate(id: string, wires: DelegateWires, settings: DelegateSettings, meta?: NodeMeta): DelegateNode
  /**
   * Fan Out: Starts one child run of a persona per item in a list, a few at a time, and waits for all of them. Each child gets { item, index }. Every outcome is handed on, successes and failures alike — use Merge to keep the ones you want.
   * Leaves through done: Every child has finished.
   */
  fanOut(id: string, wires: FanOutWires, settings: FanOutSettings, meta?: NodeMeta): FanOutNode
  /** Finish: Ends the run with an outcome and a reason. A wired reason replaces the written one, so a check that tripped can say what it saw. */
  finish(id: string, wires: FinishWires, settings: FinishSettings, meta?: NodeMeta): FinishNode
  /**
   * Merge: Reduces the outcomes of delegated work to the ones you want: all of them, only the ones that succeeded, the first that succeeded, or only the failures.
   * Leaves through done: Always.
   */
  merge(id: string, wires?: MergeWires, settings?: MergeSettings, meta?: NodeMeta): MergeNode
  /**
   * Wait for Person: Shows a person a message and pauses the run until they answer or the time runs out.
   * Leaves through answered: The person answered.
   * Leaves through unanswered: Nobody answered in time, or the run was cancelled.
   */
  waitForPerson(id: string, wires: WaitForPersonWires, settings: WaitForPersonSettings, meta?: NodeMeta): WaitForPersonNode
  /**
   * Provision Sandbox: Gets the run somewhere to work, derived from the tools its persona is granted: nothing, a fresh sandbox pod built from a matching image, or a registered machine. Pair it with Release Sandbox in the cleanup lane.
   * Leaves through ready: The environment is ready.
   * Leaves through unavailable: No suitable environment could be provided, and the output says why.
   */
  provisionSandbox(id: string, wires?: ProvisionSandboxWires, settings?: ProvisionSandboxSettings, meta?: NodeMeta): ProvisionSandboxNode
  /**
   * Release Sandbox: Releases the run's sandbox so it stops using the cluster. Safe to run when there is none, and safe to run twice.
   * Leaves through done: Released, or there was nothing to release.
   */
  releaseSandbox(id: string, wires?: ReleaseSandboxWires, settings?: ReleaseSandboxSettings, meta?: NodeMeta): ReleaseSandboxNode
  /** Persona: The persona this run is bound to: its prompt, granted tools, delegates, sampling and model. */
  persona(id: string, wires?: PersonaWires, settings?: PersonaSettings, meta?: NodeMeta): PersonaNode
  /** Run Input: What this run was started with: the message, and any named inputs. */
  runInput(id: string, wires?: RunInputWires, settings?: RunInputSettings, meta?: NodeMeta): RunInputNode
  /** Recall Memory: Picks the owner's active memories that apply here — project ones first, then global, newest first — and renders them as a prompt section within a character budget, saying how many were left out. */
  recallMemory(id: string, wires?: RecallMemoryWires, settings?: RecallMemorySettings, meta?: NodeMeta): RecallMemoryNode
  /**
   * Save Memory: Writes something worth remembering for later runs. A project memory is refused when the run has no project, because it could never be recalled.
   * Leaves through saved: It was saved.
   * Leaves through refused: It could not be saved, and the output says why.
   */
  saveMemory(id: string, wires?: SaveMemoryWires, settings?: SaveMemorySettings, meta?: NodeMeta): SaveMemoryNode
  /**
   * Call Model: Sends the system prompt, the conversation and the offered tools to the model, streams the reply, and leaves by what the reply turned out to be.
   * Leaves through toolCalls: It asked for one or more tools.
   * Leaves through answered: It replied without asking for tools.
   * Leaves through truncated: It ran out of reply tokens mid-reply.
   * Leaves through empty: It stopped without saying or asking for anything.
   */
  callModel(id: string, wires?: CallModelWires, settings?: CallModelSettings, meta?: NodeMeta): CallModelNode
  /** Choose Model: Picks the endpoint and model to call, the sampling to call it with, and the most a reply may ever use. No API key travels on the wire; Call Model looks it up when it calls. */
  chooseModel(id: string, wires?: ChooseModelWires, settings?: ChooseModelSettings, meta?: NodeMeta): ChooseModelNode
  /**
   * Decide: Asks a model a yes-or-no question about some text — for example whether a judge's verdict says the work passed — and leaves through yes, no or unsure.
   * Leaves through yes: The model answered yes.
   * Leaves through no: The model answered no.
   * Leaves through unsure: The model was unsure, or did not answer with yes or no.
   */
  decide(id: string, wires: DecideWires, settings: DecideSettings, meta?: NodeMeta): DecideNode
  /** Fit Reply Budget: Works out how many tokens the reply may use from what is left of the context window once the real prompt is in it, and how full the window is. */
  fitReplyBudget(id: string, wires?: FitReplyBudgetWires, settings?: FitReplyBudgetSettings, meta?: NodeMeta): FitReplyBudgetNode
  /**
   * Check Repetition: Trips when the model keeps thinking and doing nearly the same thing turn after turn.
   * Leaves through ok: Nothing wrong yet.
   * Leaves through tripped: The check tripped; "reason" says what it saw.
   */
  checkRepetition(id: string, wires?: CheckRepetitionWires, settings?: CheckRepetitionSettings, meta?: NodeMeta): CheckRepetitionNode
  /**
   * Check Stall: Trips when the model has neither said anything nor asked for a tool for several replies in a row.
   * Leaves through ok: Nothing wrong yet.
   * Leaves through tripped: The check tripped; "reason" says what it saw.
   */
  checkStall(id: string, wires?: CheckStallWires, settings?: CheckStallSettings, meta?: NodeMeta): CheckStallNode
  /**
   * Check Tool Failures: Trips when tool calls keep failing one after another, across replies. A call the peer refused — a site that blocks fetches replying 403 or 401 — is not a failure and does not count.
   * Leaves through ok: Nothing wrong yet.
   * Leaves through tripped: The check tripped; "reason" says what it saw.
   */
  checkToolFailures(id: string, wires?: CheckToolFailuresWires, settings?: CheckToolFailuresSettings, meta?: NodeMeta): CheckToolFailuresNode
  /**
   * Approve Tool Calls: Asks a person to allow each tool call before it runs. By default it only asks when the run is working on someone's own machine; sandboxes and the platform go straight through. A refused call gets a result saying so, which goes back to the model.
   * Leaves through approved: At least one call may run.
   * Leaves through refused: Every call was refused.
   */
  approveToolCalls(id: string, wires?: ApproveToolCallsWires, settings?: ApproveToolCallsSettings, meta?: NodeMeta): ApproveToolCallsNode
  /**
   * Call Tool: Runs one named tool with arguments you write, without asking the model. Arguments are JSON. {{values.name}} is replaced with that part of the wired values, and {{text}} with the wired text.
   * Leaves through ok: The tool succeeded.
   * Leaves through failed: The tool failed or was refused.
   */
  callTool(id: string, wires: CallToolWires, settings: CallToolSettings, meta?: NodeMeta): CallToolNode
  /**
   * Run Tool Calls: Runs every tool call in the reply, in order. A call naming a persona this one may delegate to starts that persona as a child run; every other call runs wherever its tool lives — the sandbox, a registered machine, or the platform. Each result is tagged with its call and the reply it answers.
   * Leaves through done: Every call has a result, whether it succeeded or not.
   */
  runToolCalls(id: string, wires?: RunToolCallsWires, settings?: RunToolCallsSettings, meta?: NodeMeta): RunToolCallsNode
}

export interface BuiltInGroups {
  /**
   * Model Turn: One call to the model with everything it needs: the persona's prompt, where it is working, the tools it can and cannot use, what it remembers, and what its answer must contain — fitted to the context window.
   * Leaves through toolCalls: The model asked for tools.
   * Leaves through answered: The model replied without asking for tools.
   * Leaves through truncated: The reply was cut off by the token cap.
   * Leaves through empty: The model said and asked for nothing.
   */
  modelTurn(id: string, wires?: ModelTurnGroupWires, meta?: NodeMeta): ModelTurnGroupNode
  /**
   * Tool Loop: Asks for approval where it is needed, runs the tools a reply asked for, trims what comes back to fit the context, and stops the run when calls keep failing.
   * Leaves through done: The tools ran.
   * Leaves through refused: Every call was refused, so nothing ran.
   * Leaves through failing: Tool calls kept failing.
   */
  toolLoop(id: string, wires?: ToolLoopGroupWires, meta?: NodeMeta): ToolLoopGroupNode
}

export interface Body extends Nodes {
  /** The built-in groups, each used as one node. */
  readonly groups: BuiltInGroups
  /** Defines a group of nodes that can be used as one node, then returns it for use(…). */
  group<const I extends Sockets = {}, const O extends Sockets = {}, const E extends Exits = {}>(id: string, info: GroupInfo<I, O, E>, build: (g: GroupBody<I, O, E>) => void): GroupRef<I, O, E>
  /** Places one of this procedure's own groups as a node. */
  use<I extends Sockets, O extends Sockets, E extends Exits>(group: GroupRef<I, O, E>, id: string, wires?: GroupWires<I>, meta?: NodeMeta): GroupNode<I, O, E>
  /** Where each node sits on the canvas. */
  layout(positions: Layout): void
}

export interface ProcedureBody extends Body {
  /** The step the procedure starts at. */
  start(step: Step<string>): void
  /** The step that runs last, however the procedure ends. */
  cleanup(step: Step<string>): void
}

export interface GroupBody<I extends Sockets, O extends Sockets, E extends Exits> extends Body {
  /** What the group is given, to wire into the nodes inside it. */
  readonly inputs: { readonly [K in keyof I]: Out<I[K]['type']> }
  /** Where an exit leaves the group, as in call.on('answered', g.exits.answered). */
  readonly exits: { readonly [K in keyof E]: ExitTarget }
  /** Hands a value from inside the group out through one of its outputs. */
  output<K extends Extract<keyof O, string>>(name: K, from: In<O[K]['type']>): void
  /** The step the group starts at. */
  start(step: Step<string>): void
}

export interface Budget {
  maxRounds?: number
  maxToolCalls?: number
  maxTokens?: number
  maxWallClockMs?: number
  maxDepth?: number
  maxChildRuns?: number
}

export interface ProcedureMeta {
  id: string
  version?: string
  name?: string
  describe?: string
  budget?: Budget
}
