import { describe, expect, it } from 'vitest';
import { exportsIn } from './exports.js';
import { type Flow, type Known, flowProblems, stepsOf } from './flow-spec.js';

const known: Known = {
  decisions: new Set(['gpu-is-core', 'how-a-machine-cluster-is-made']),
  files: new Set(['ui/Deploy.tsx']),
  exportsOf: () => new Set(['default', 'AppsSection']),
};

const flow = (steps: Flow['steps']): Flow => ({ id: 'E', title: 'Run a model', who: 'Infrastructure', steps });

const deploy: Flow['steps'][number] = {
  id: 'E1', does: 'They deploy vLLM', screen: { on: 'instance', component: 'ui/Deploy.tsx#AppsSection' }, decisions: ['gpu-is-core'],
};

describe('a flow, held to the register and the repository', () => {
  it('passes a step on a screen that exists, resting on a decision in the register', () => {
    expect(flowProblems([flow([deploy])], known)).toEqual([]);
  });

  it('names a decision the register does not hold, in a step or in a branch', () => {
    expect(flowProblems([flow([{ ...deploy, decisions: ['gpu-optional'] }])], known)).toEqual(['E1: no decision gpu-optional in the register']);
    const branched = { ...deploy, branches: [{ when: 'no Docker', outcome: 'k3s', decision: 'docker-required' }] };
    expect(flowProblems([flow([branched])], known)).toEqual(['E1: no decision docker-required in the register']);
  });

  it('names a screen whose file or export is not there, or that is not written as file#export', () => {
    expect(flowProblems([flow([{ ...deploy, screen: { on: 'instance', component: 'ui/Gone.tsx#AppsSection' } }])], known)).toEqual(['E1: no file ui/Gone.tsx']);
    expect(flowProblems([flow([{ ...deploy, screen: { on: 'instance', component: 'ui/Deploy.tsx#Wizard' } }])], known)).toEqual(['E1: ui/Deploy.tsx exports no Wizard']);
    expect(flowProblems([flow([{ ...deploy, screen: { on: 'instance', component: 'ui/Deploy.tsx' } }])], known)).toEqual(['E1: the screen\'s component ui/Deploy.tsx is not <file>#<export>']);
  });

  it('wants a component for a step on root\'s or an instance\'s pages, and none for a terminal', () => {
    expect(flowProblems([flow([{ ...deploy, screen: { on: 'instance' } }])], known)).toEqual(['E1: a step on instance\'s pages names no component']);
    expect(flowProblems([flow([{ ...deploy, screen: { on: 'terminal' } }])], known)).toEqual([]);
  });

  it('wants every step to rest on a decision or say what it assumes', () => {
    expect(flowProblems([flow([{ ...deploy, decisions: [] }])], known)).toEqual(['E1: rests on no decision and says no assumption']);
    expect(flowProblems([flow([{ ...deploy, decisions: [], assumed: 'built before the register' }])], known)).toEqual([]);
  });

  it('refuses a repeated step or flow id, and a step named for another flow', () => {
    expect(flowProblems([flow([deploy, deploy])], known)).toEqual(['E1: the id is used twice']);
    expect(flowProblems([flow([deploy]), { ...flow([{ ...deploy, id: 'E2' }]) }], known)).toEqual(['flow E: the id is used twice']);
    expect(flowProblems([flow([{ ...deploy, id: 'B1' }])], known)).toEqual(['B1: a step of flow E is named for another flow']);
  });

  it('lists the steps each decision settles, once each', () => {
    const branched = { ...deploy, id: 'E2', branches: [{ when: 'a GPU', outcome: 'k3s', decision: 'gpu-is-core' }, { when: 'no GPU', outcome: 'k3d', decision: 'how-a-machine-cluster-is-made' }] };
    expect(stepsOf([flow([deploy, branched])])).toEqual(new Map([['gpu-is-core', ['E1', 'E2']], ['how-a-machine-cluster-is-made', ['E2']]]));
  });
});

describe('what a file exports, as TypeScript reads it', () => {
  it('names default and named exports of every kind, and leaves out what is not exported', () => {
    const source = [
      'export default function Login() { return null }',
      'export function AppsSection() { return null }',
      'export const useApps = () => 1',
      'export interface AppRow { id: string }',
      'export type Kind = string',
      'export { helper as renamed }',
      'function helper() {}',
      'const hidden = 1',
    ].join('\n');
    expect(exportsIn(source, 'x.tsx')).toEqual(new Set(['default', 'AppsSection', 'useApps', 'AppRow', 'Kind', 'renamed']));
  });

  it('takes export default of an expression as the default export', () => {
    expect(exportsIn('const page = 1\nexport default page', 'x.ts')).toEqual(new Set(['default']));
  });
});
