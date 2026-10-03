import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import type { ToolHandler } from '@koala/engine-core';

export type HostOperationRun = (request: NodeRequest) => Promise<StepResult>;

export interface ExtensionRuntime {
  operations: Readonly<Record<string, HostOperationRun>>;
  tools: Readonly<Record<string, ToolHandler>>;
}
