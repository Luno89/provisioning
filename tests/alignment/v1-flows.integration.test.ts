import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DECISIONS } from './decisions.js';
import { exportsOfFile } from './exports.js';
import { type Known, flowProblems } from './flow-spec.js';
import { V1_FLOWS } from './v1-flows.js';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const known: Known = {
  decisions: new Set(DECISIONS.map((decision) => decision.id)),
  files: new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')),
  exportsOf: exportsOfFile(root),
};

describe('the v1 flows, against this repository and the register', () => {
  it('has every step resting on a decision in the register, on a screen that exists', () => {
    expect(flowProblems(V1_FLOWS, known)).toEqual([]);
  });

  it('notices a screen component that this repository does not export', () => {
    const renamed = V1_FLOWS.map((flow) => flow.id !== 'E' ? flow : {
      ...flow,
      steps: flow.steps.map((step) => step.id !== 'E1' ? step : { ...step, screen: { ...step.screen, component: 'apps/frontend/src/features/infrastructure/components/AppsSection.tsx#AppList' } }),
    });
    expect(flowProblems(renamed, known)).toEqual(['E1: apps/frontend/src/features/infrastructure/components/AppsSection.tsx exports no AppList']);
  });

  it('settles every branch of a machine\'s cluster in the decision about how it is made', () => {
    const join = V1_FLOWS.flatMap((flow) => flow.steps).find((step) => step.id === 'B4');
    expect(join?.branches?.map((branch) => branch.decision)).toEqual(['how-a-machine-cluster-is-made', 'how-a-machine-cluster-is-made', 'how-a-machine-cluster-is-made', 'how-a-machine-cluster-is-made']);
  });
});
