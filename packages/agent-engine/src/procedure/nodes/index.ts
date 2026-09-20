import { createNodeCatalogue, type NodeCatalogue, type NodeDefinition } from '../definition.js';
import type { BuiltInNode, NodeImplementation } from '../implementation.js';
import { CONTEXT_NODES } from './context.js';
import { CONTROL_NODES } from './control.js';
import { ENVIRONMENT_NODES } from './environment.js';
import { INPUT_NODES } from './input.js';
import { MEMORY_NODES } from './memory.js';
import { MODEL_NODES } from './model.js';
import { SAFETY_NODES } from './safety.js';
import { CODE_NODES } from './code.js';
import { TOOL_NODES } from './tools.js';

export const BUILT_IN_NODES: readonly BuiltInNode[] = [
  ...INPUT_NODES,
  ...MODEL_NODES,
  ...CONTEXT_NODES,
  ...MEMORY_NODES,
  ...TOOL_NODES,
  ...ENVIRONMENT_NODES,
  ...CONTROL_NODES,
  ...SAFETY_NODES,
  ...CODE_NODES,
];

export const BUILT_IN_DEFINITIONS: readonly NodeDefinition[] = BUILT_IN_NODES.map((node) => node.definition);

export const WORKFLOW_IMPLEMENTATIONS: readonly NodeImplementation[] = BUILT_IN_NODES
  .map((node) => node.implementation)
  .filter((implementation): implementation is NodeImplementation => implementation !== undefined);

export const ORCHESTRATION_KINDS: readonly string[] = BUILT_IN_NODES
  .filter((node) => node.definition.runs === 'orchestration')
  .map((node) => node.definition.kind);

export const HOST_KINDS: readonly string[] = BUILT_IN_NODES
  .filter((node) => node.implementation === undefined && node.definition.runs !== 'orchestration')
  .map((node) => node.definition.kind);

export const builtInCatalogue = (): NodeCatalogue => createNodeCatalogue(BUILT_IN_DEFINITIONS);

export { resolveTools, withdrawTools, describeEnvironmentNode, describeProcedure, describeTools, describeOutputsNode, warnRunningOut, text, buildContext, conversation, trimToolResults, truncateText, cappedText, handOffConversation, resolvedEnvironment, extendConversation, clampToolResult, handOff, pacingText, NO_ENVIRONMENT, type PacingNote, type HandOffSettings } from './context.js';
export { condition, merge, collect, finish, delegate, fanOut, waitForPerson, CONDITION_ROOTS, FINISH_OUTCOMES } from './control.js';
export { provisionSandbox, releaseSandbox } from './environment.js';
export { runInput, persona } from './input.js';
export { recallMemory, saveMemory, MEMORY_CATEGORIES } from './memory.js';
export { chooseModel, fitReplyBudget, callModel, decide, readDecision, DECIDE_INSTRUCTIONS, DECISIONS, type Decision, DEFAULT_CONTEXT_MARGIN, DEFAULT_MIN_REPLY_TOKENS } from './model.js';
export { checkRepetition, checkStall, checkToolFailures } from './safety.js';
export { code, codeProblems, declaredSockets, codeTimeout, CODE_KIND, DEFAULT_CODE_TIMEOUT_MS, type DeclaredSocket } from './code.js';
export { approveToolCalls, runToolCalls, callTool, APPROVAL_POLICIES } from './tools.js';
export { createOrchestrationNodes, REFUSED_CALL, type OrchestrationPorts, type ToolRunRequest, type ToolRunOutcome, type ChildRunRequest, type ApprovalRequest, type QuestionRequest, type QuestionAnswer } from './orchestration.js';
