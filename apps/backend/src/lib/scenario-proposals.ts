import type { Scenario } from '../eval/level2/scenario.js';
import type { EvalRecord } from './eval-run.js';

export type ProposalStatus = 'proposed' | 'accepted' | 'dismissed';

export interface ScenarioProposal extends EvalRecord {
  scenario: Scenario;
  why: string;
  status: ProposalStatus;
  proposedBy?: string | undefined;
  createdAt: string;
  decidedAt?: string | undefined;
}

export const scenarioIdFor = (agent: string, name: string): string =>
  `${agent}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export interface ProposedExpectations {
  outcome?: string | undefined;
  toolsCalled?: string[] | undefined;
  toolsNotCalled?: string[] | undefined;
  toolsInOrder?: string[] | undefined;
}

export function proposedScenario(input: {
  agent: string;
  procedure: string;
  name: string;
  checks: string;
  message: string;
  expect: ProposedExpectations;
}): Scenario {
  const expect = Object.fromEntries(Object.entries(input.expect).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)));
  return {
    id: scenarioIdFor(input.agent, input.name),
    name: input.name,
    describe: input.checks,
    agent: input.agent,
    procedure: { id: input.procedure },
    input: { message: input.message },
    expect,
  };
}
