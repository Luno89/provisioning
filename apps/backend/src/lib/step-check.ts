import { PROCEDURE_SCHEMA, definitionFor, type NodeCatalogue, type PlacedNode, type Procedure, type Wire, type Flow } from '@koala/agent-engine/procedure';

export interface StepUnderTest {
  node: string;
  settings?: Record<string, unknown> | undefined;
  inputs?: Record<string, unknown> | undefined;
  from?: string | undefined;
}

export const STEP_NODE = 'step';
export const stepProcedureId = (scenarioId: string): string => `step-check-${scenarioId}`;

const at = (x: number, y: number) => ({ x, y });

export function stepProcedure(scenarioId: string, step: StepUnderTest, catalogue: NodeCatalogue): { procedure: Procedure } | { problems: string[] } {
  const settings = step.settings ?? {};
  const definition = definitionFor(catalogue, { kind: step.node, settings });
  if (!definition) return { problems: [`there is no node called "${step.node}"`] };
  if (definition.runs === 'workflow' && definition.role === 'step' && ['finish', 'condition'].includes(definition.kind)) return { problems: [`${definition.kind} is part of how a procedure flows, not a step to check`] };

  const given = step.inputs ?? {};
  const unknown = Object.keys(given).filter((name) => !definition.inputs.some((socket) => socket.name === name));
  if (unknown.length > 0) return { problems: unknown.map((name) => `${step.node} has no input called "${name}"`) };

  const nodes: PlacedNode[] = [{ id: 'input', kind: 'run-input', settings: {}, position: at(0, 0) }];
  const wires: Wire[] = [];
  const flow: Flow[] = [];
  let needsPersona = false;
  let needsEnvironment = false;

  definition.inputs.forEach((socket, index) => {
    if (socket.name in given) {
      nodes.push({ id: `in-${socket.name}`, kind: 'value', settings: { json: JSON.stringify(given[socket.name]) }, position: at(0, 140 * (index + 1)) });
      wires.push({ from: { node: `in-${socket.name}`, socket: 'value' }, to: { node: STEP_NODE, socket: socket.name } });
    } else if (socket.type === 'environment') {
      needsEnvironment = true;
      wires.push({ from: { node: 'provision', socket: 'environment' }, to: { node: STEP_NODE, socket: socket.name } });
    } else if (socket.type === 'persona') {
      needsPersona = true;
      wires.push({ from: { node: 'persona', socket: 'persona' }, to: { node: STEP_NODE, socket: socket.name } });
    } else if (socket.type === 'modelBinding') {
      needsPersona = true;
      if (!nodes.some((node) => node.id === 'model')) nodes.push({ id: 'model', kind: 'choose-model', settings: {}, position: at(260, 140) });
      wires.push({ from: { node: 'model', socket: 'binding' }, to: { node: STEP_NODE, socket: socket.name } });
    } else if (socket.name === 'message' && socket.type === 'text') {
      wires.push({ from: { node: 'input', socket: 'message' }, to: { node: STEP_NODE, socket: socket.name } });
    }
  });
  if (nodes.some((node) => node.id === 'model')) wires.push({ from: { node: 'persona', socket: 'persona' }, to: { node: 'model', socket: 'persona' } });
  if (needsPersona) nodes.push({ id: 'persona', kind: 'persona', settings: {}, position: at(0, -140) });

  nodes.push({ id: STEP_NODE, kind: step.node, settings, position: at(520, 0) });

  let start = STEP_NODE;
  if (definition.role === 'step') {
    definition.exits.forEach((exit, index) => {
      const id = `exit-${exit.name}`;
      nodes.push({ id, kind: 'finish', settings: { outcome: 'ok', reason: exit.name }, position: at(780, 140 * index) });
      flow.push({ from: STEP_NODE, exit: exit.name, to: id });
    });
  } else {
    const first = definition.outputs[0];
    nodes.push({ id: 'exit-value', kind: 'finish', settings: { outcome: 'ok', reason: 'value' }, position: at(780, 0) });
    if (first) wires.push({ from: { node: STEP_NODE, socket: first.name }, to: { node: 'exit-value', socket: 'result' } });
    start = 'exit-value';
  }

  if (needsEnvironment) {
    nodes.push({ id: 'provision', kind: 'provision-sandbox', settings: {}, position: at(260, 0) });
    nodes.push({ id: 'unavailable', kind: 'finish', settings: { outcome: 'failed', reason: 'no sandbox could be provided for the step' }, position: at(260, 140) });
    flow.push({ from: 'provision', exit: 'ready', to: start }, { from: 'provision', exit: 'unavailable', to: 'unavailable' });
    start = 'provision';
  }

  return {
    procedure: {
      schema: PROCEDURE_SCHEMA,
      id: stepProcedureId(scenarioId),
      version: '1',
      name: `Step check: ${definition.title}`,
      describe: `Runs one ${definition.title} node with the inputs its check gives it.`,
      budget: {},
      start,
      nodes,
      wires,
      flow,
      groups: [],
    },
  };
}
