import type { NodeCatalogue, NodeDefinition } from './definition.js';
import type { NodeExecutor, NodeRequest, StepResult, ValueResult } from './interpreter.js';

export type StepImplementation = (request: NodeRequest) => StepResult | Promise<StepResult>;
export type ValueImplementation = (request: NodeRequest) => ValueResult | Promise<ValueResult>;

export type NodeImplementation =
  | { kind: string; role: 'step'; run: StepImplementation }
  | { kind: string; role: 'value'; run: ValueImplementation };

export interface BuiltInNode {
  definition: NodeDefinition;
  implementation?: NodeImplementation | undefined;
}

export const stepImplementation = (kind: string, run: StepImplementation): NodeImplementation => ({ kind, role: 'step', run });
export const valueImplementation = (kind: string, run: ValueImplementation): NodeImplementation => ({ kind, role: 'value', run });

export class NodeImplementationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeImplementationError';
  }
}

export function implementationProblems(
  catalogue: NodeCatalogue,
  implementations: readonly NodeImplementation[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, NodeImplementation>();

  for (const implementation of implementations) {
    if (seen.has(implementation.kind)) problems.push(`"${implementation.kind}" is implemented twice`);
    seen.set(implementation.kind, implementation);

    const definition = catalogue.get(implementation.kind);
    if (!definition) {
      problems.push(`"${implementation.kind}" is implemented but is not a kind of node`);
    } else if (definition.role !== implementation.role) {
      problems.push(`"${implementation.kind}" is a ${definition.role} node but is implemented as a ${implementation.role}`);
    }
  }

  for (const definition of catalogue.list()) {
    if (!seen.has(definition.kind)) problems.push(`"${definition.kind}" has no implementation`);
  }

  return problems;
}

export function createNodeExecutor(
  catalogue: NodeCatalogue,
  implementations: readonly NodeImplementation[],
): NodeExecutor {
  const problems = implementationProblems(catalogue, implementations);
  if (problems.length > 0) {
    throw new NodeImplementationError(`nodes are not ready to run:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }

  const byKind = new Map(implementations.map((implementation) => [implementation.kind, implementation]));

  return {
    async step(request) {
      const implementation = byKind.get(request.node.kind);
      if (implementation?.role !== 'step') throw new NodeImplementationError(`"${request.node.kind}" cannot run as a step`);
      return implementation.run(request);
    },
    async value(request) {
      const implementation = byKind.get(request.node.kind);
      if (implementation?.role !== 'value') throw new NodeImplementationError(`"${request.node.kind}" cannot be worked out as a value`);
      return implementation.run(request);
    },
  };
}
