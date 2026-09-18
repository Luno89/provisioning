export type { ProcedureSource } from './agent/procedure-source.js';

// Events & Bus
export {
  createEventBus,
  type EventBus,
  type EngineEvent,
  type EventBase,
  type RunOutcome,
} from './runtime/events.js';

// Run State & Budget
export {
  createRunState,
  applyModelResult,
  recordToolOutcome,
  budgetExceeded,
  settle,
  type RunState,
  type RunBudget,
  type RunIdentity,
  type RunResult,
} from './runtime/run.js';

// Monitors
export {
  createMonitorSet,
  overthinkMonitor,
  repetitionMonitor,
  stallMonitor,
  toolFailureMonitor,
  type Monitor,
  type MonitorSet,
  type MonitorContext,
} from './runtime/monitors.js';

// Approval Gates
export {
  allowAll,
  denyAll,
  createApprovalGate,
  type ApprovalGate,
} from './runtime/approval.js';

// Agents & Personas
export {
  resolveAgent,
  visibleAgents,
  environmentFor,
  needsWorkspace,
  activeGrants,
  capabilitiesFor,
  type AgentDefinition,
  type Persona,
  type EgressMode,
  type EgressGrant,
} from './agent/agent.js';

// Tool Catalogue & Contracts
export {
  contractsFor,
  checkDefinition,
  asContract,
  approved,
  type ToolDefinition,
  type ToolStatus,
  type ToolEffect,
  type Failure,
  type Install,
  type Reachability,
  type JsonSchema,
  type CatalogueProblem,
} from './tools/catalogue.js';
export type { ToolContract } from '@koala/engine-core';

// Builtin Step Handlers

// Model Calling & Sampling
export {
  callModel,
  ModelCallError,
  type ModelCallSpec,
  type ModelCallResult,
  type EngineEndpoint,
} from './model/model-call.js';
export {
  fittedMaxTokens,
  turnMaxTokens,
  contextPressure,
  NO_THINKING,
} from './model/sampling.js';
export { resolveSampling } from './model/pack-sampling.js';

// Stream Parser
export {
  createStreamParser,
  type StreamEvent,
  type StreamToolCall,
  type StreamParser,
} from './runtime/stream.js';

// Context & Environment Composition
export {
  resolveToolSet,
  type ToolSetRequest,
  type ComposedContext,
  type ResolvedEnvironment,
  type ContextRequest,
} from './runtime/context.js';
export {
  describeWorkspace,
  describeForDelegation,
  describeMachine,
  describeNoEnvironment,
  packageAccessFor,
  absentFrom,
  workspaceName,
  lifetimeFor,
  egressFor,
  type RunWorkspace,
  type EgressRule,
  type PackageAccess,
} from './environment/workspace.js';
export {
  BASES,
  baseFor,
  planImage,
  imageReference,
  needsBuilding,
  renderDockerfile,
  type ImagePlan,
  type BaseImage,
} from './environment/image.js';
export type { ModelProvider } from './model/model-registry.js';

// Builder Tool Schemas
export { BUILDER_TOOLS } from './tools/builder-tools-catalogue.js';

// Built-in Seeds
export {
  SEEDED_AGENTS,
  ALL_SEEDED_AGENTS,
  seededAgentSlugs,
  definedToolNames,
  STANDARD_HOST_TOOL_NAMES,
} from './agent/seeds.js';
