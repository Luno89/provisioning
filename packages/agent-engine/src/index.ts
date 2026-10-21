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
  isFork,
  environmentFor,
  needsWorkspace,
  capabilitiesFor,
  type AgentDefinition,
  type Persona,
  type PersonaRecord,
  type EgressMode,
} from './agent/agent.js';
export {
  sourcedTools,
  toolsOf,
  withTools,
  withGrants,
  grantChanges,
  kindOfGrant,
  grantsFrom,
  toRecord,
  type ToolGrant,
  type GrantKind,
  type ToolSource,
  type SourcedTool,
  type GrantChanges,
  type GrantMap,
} from './agent/grants.js';

// Tool Catalogue & Contracts
export {
  contractsFor,
  checkDefinition,
  asContract,
  type ToolDefinition,
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
export { getModelRateLimiterSnapshot, type ModelRateLimitBucketSnapshot } from './model/model-rate-limiter.js';
export { patientFetch } from './model/patient-fetch.js';
export { sameCircle, circlingNudge, circlingNotice } from './model/circling.js';

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
  DEFAULT_BASE,
  UnbuildableError,
  LANGUAGE_IDS,
  baseFor,
  languagesFor,
  planImage,
  planFor,
  imageReference,
  needsBuilding,
  renderDockerfile,
  proofScript,
  type DependencyProof,
  type ImagePlan,
  type PlanLine,
  type Contribution,
  type BaseImage,
} from './environment/image.js';
export {
  LANGUAGE_DEPENDENCIES,
  MANAGER_NEEDS,
  DEPENDENCY_NAME,
  dependencyProblems,
  resolveNeeds,
  UnknownDependencyError,
  DependencyCycleError,
  type WorkspaceDependency,
  type Need,
  type ResolvedDependency,
} from './environment/dependencies.js';
export type { ModelProvider } from './model/model-registry.js';

// Builder Tool Schemas
export { BUILDER_TOOLS } from './tools/builder-tools-catalogue.js';

// Built-in Seeds
export {
  SEEDED_AGENTS,
  SEEDED_GRANTS,
  ALL_SEEDED_AGENTS,
  seededAgentSlugs,
  definedToolNames,
} from './agent/seeds.js';
