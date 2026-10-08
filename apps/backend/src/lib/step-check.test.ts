import { describe, it, expect } from 'vitest';
import { formatProcedureProblems, readAndCheckProcedure } from '@koala/agent-engine/procedure';
import { stepProcedure } from './step-check.js';
import { platformCatalogue, platformGroups } from '../extensions/installed.js';

const catalogue = platformCatalogue();
const checked = (step: Parameters<typeof stepProcedure>[1]) => {
  const built = stepProcedure('s1', step, catalogue);
  if ('problems' in built) throw new Error(built.problems.join('; '));
  const read = readAndCheckProcedure(built.procedure as never, { catalogue, groups: platformGroups() });
  if (!read.ok) throw new Error(formatProcedureProblems(read.problems));
  return built.procedure;
};

describe('a step check wraps one node in a procedure', () => {
  it('reads a value node into the finish', () => {
    const procedure = checked({ node: 'text', settings: { text: 'hello' } });
    expect(procedure.start).toBe('exit-value');
    expect(procedure.wires).toContainEqual({ from: { node: 'step', socket: 'text' }, to: { node: 'exit-value', socket: 'result' } });
  });

  it('gives a model step its persona and model, feeds the rest from values, and finishes on each of its exits', () => {
    const procedure = checked({ node: 'decide', settings: { question: 'Is it done?' }, inputs: { text: 'It is done.' } });
    expect(procedure.nodes.map((node) => node.kind).sort()).toEqual(['choose-model', 'decide', 'finish', 'finish', 'finish', 'persona', 'run-input', 'value']);
    expect(procedure.flow.map((entry) => entry.exit).sort()).toEqual(['no', 'unsure', 'yes']);
  });

  it('starts a sandbox first for a step that works in one', () => {
    const procedure = checked({ node: 'run-code', settings: { body: 'return { result: 42 }', outputs: [{ name: 'result', type: 'json' }] } });
    expect(procedure.start).toBe('provision');
    expect(procedure.flow).toContainEqual({ from: 'provision', exit: 'ready', to: 'step' });
  });

  it('says what is wrong with a step it cannot wrap', () => {
    expect(stepProcedure('s1', { node: 'teleport' }, catalogue)).toEqual({ problems: ['there is no node called "teleport"'] });
    expect(stepProcedure('s1', { node: 'decide', inputs: { mood: 1 } }, catalogue)).toEqual({ problems: ['decide has no input called "mood"'] });
  });
});
