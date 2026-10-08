import type { Scenario, ScenarioExpectations } from '../api/evals'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: apps/backend/src/lib/check-subjects.ts, which the check writer's tools use. The page works out the same
 * subjects from the same scenario, so a check shows on the same pages the agent finds it under.
 */
export interface Subjects {
  agents: string[]
  procedures: string[]
  tools: string[]
}

export type Scope = { agent: string } | { tool: string } | { procedure: string }

const unique = (values: (string | undefined | null)[]): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))].sort()

const toolsExpected = (expect: ScenarioExpectations | undefined): string[] => [
  ...(expect?.toolsCalled ?? []),
  ...(expect?.toolsNotCalled ?? []),
  ...(expect?.toolsSucceeded ?? []),
  ...(expect?.toolsInOrder ?? []),
  ...(expect?.provokes ? [expect.provokes.tool] : []),
  ...(expect?.chooses?.tool ? [expect.chooses.tool] : []),
]

export function scenarioSubjects(scenario: Scenario): Subjects {
  const expectations = [scenario.expect, ...(scenario.then ?? []).map((stage) => stage.expect)]
  const stepTool = scenario.step?.node === 'call-tool' && typeof scenario.step.settings?.tool === 'string' ? scenario.step.settings.tool : undefined
  return {
    agents: unique([scenario.agent, ...expectations.flatMap((expect) => (expect?.handOffs ?? []).map((handOff) => handOff.agent))]),
    procedures: unique([scenario.turn ? undefined : scenario.step ? scenario.step.from : scenario.procedure.id]),
    tools: unique([stepTool, ...expectations.flatMap(toolsExpected)]),
  }
}

export function within(subjects: Subjects, scope: Scope): boolean {
  if ('agent' in scope) return subjects.agents.includes(scope.agent)
  if ('tool' in scope) return subjects.tools.includes(scope.tool)
  return subjects.procedures.includes(scope.procedure)
}

export function scopeLabel(scope: Scope): string {
  if ('agent' in scope) return `the ${scope.agent} agent`
  if ('tool' in scope) return `the ${scope.tool} tool`
  return `the ${scope.procedure} procedure`
}
