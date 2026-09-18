import type { Scenario, ScenarioExpectations, ScenarioWorld } from '../api/evals'

export interface ScenarioDraft {
  id: string
  name: string
  describe: string
  agent: string
  procedure: string
  version: string
  message: string
  inputs: string
  world: string
  answers: string
  approvals: 'allow' | 'refuse'
  acceptProposedWork: boolean
  outcome: string
  toolsCalled: string
  toolsNotCalled: string
  toolsInOrder: string
  rounds: string
  toolCalls: string
  totalTokens: string
  provokesTool: string
  provokesWhen: string
  provokesThen: 'retried' | 'reported'
  savedProcedure: string
  savedStored: 'yes' | 'no'
}

const listOf = (text: string): string[] =>
  text.split(',').map((entry) => entry.trim()).filter(Boolean)

const textOf = (names: readonly string[] | undefined): string => (names ?? []).join(', ')

const jsonOf = (value: unknown): string => (value === undefined ? '' : JSON.stringify(value, null, 2))

export function emptyDraft(agent = ''): ScenarioDraft {
  return {
    id: '',
    name: '',
    describe: '',
    agent,
    procedure: '',
    version: '',
    message: '',
    inputs: '',
    world: '',
    answers: '',
    approvals: 'allow',
    acceptProposedWork: false,
    outcome: 'ok',
    toolsCalled: '',
    toolsNotCalled: '',
    toolsInOrder: '',
    rounds: '',
    toolCalls: '',
    totalTokens: '',
    provokesTool: '',
    provokesWhen: '',
    provokesThen: 'reported',
    savedProcedure: '',
    savedStored: 'yes',
  }
}

export function draftOf(scenario: Scenario): ScenarioDraft {
  const { acceptProposedWork, ...world } = scenario.world ?? {}
  const kept = Object.values(world).some((value) => value !== undefined) ? world : undefined

  return {
    ...emptyDraft(),
    id: scenario.id,
    name: scenario.name,
    describe: scenario.describe,
    agent: scenario.agent,
    procedure: scenario.procedure.id,
    version: scenario.procedure.version ?? '',
    message: scenario.input.message,
    inputs: jsonOf(scenario.input.inputs),
    world: jsonOf(kept),
    answers: jsonOf(scenario.answers),
    approvals: scenario.approvals ?? 'allow',
    acceptProposedWork: acceptProposedWork ?? false,
    outcome: scenario.expect.outcome ?? '',
    toolsCalled: textOf(scenario.expect.toolsCalled),
    toolsNotCalled: textOf(scenario.expect.toolsNotCalled),
    toolsInOrder: textOf(scenario.expect.toolsInOrder),
    rounds: scenario.expect.within?.rounds === undefined ? '' : String(scenario.expect.within.rounds),
    toolCalls: scenario.expect.within?.toolCalls === undefined ? '' : String(scenario.expect.within.toolCalls),
    totalTokens: scenario.expect.within?.totalTokens === undefined ? '' : String(scenario.expect.within.totalTokens),
    provokesTool: scenario.expect.provokes?.tool ?? '',
    provokesWhen: scenario.expect.provokes?.when ?? '',
    provokesThen: scenario.expect.provokes?.then ?? 'reported',
    savedProcedure: scenario.expect.saved?.procedure ?? '',
    savedStored: scenario.expect.saved?.stored === false ? 'no' : 'yes',
  }
}

const parseJson = (text: string, what: string, problems: string[]): Record<string, unknown> | undefined => {
  if (!text.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push(`${what} has to be a JSON object`)
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    problems.push(`${what} is not valid JSON: ${(err as Error).message}`)
    return undefined
  }
}

const parseCount = (text: string, what: string, problems: string[]): number | undefined => {
  if (!text.trim()) return undefined
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1) {
    problems.push(`${what} has to be a whole number of at least 1`)
    return undefined
  }
  return value
}

export type DraftOutcome = { scenario: Scenario } | { problems: string[] }

export function scenarioFromDraft(draft: ScenarioDraft): DraftOutcome {
  const problems: string[] = []

  if (!/^[a-z0-9][a-z0-9-]*$/.test(draft.id.trim())) problems.push('the id has to be lower-case words joined by dashes')
  if (!draft.name.trim()) problems.push('the scenario needs a name')
  if (!draft.describe.trim()) problems.push('the scenario has to say what it checks')
  if (!draft.agent.trim()) problems.push('the scenario has to name the persona to run')
  if (!draft.procedure.trim()) problems.push('the scenario has to name the procedure to run')
  if (!draft.message.trim()) problems.push('the scenario has to say what the run is asked to do')

  const inputs = parseJson(draft.inputs, 'the extra inputs', problems)
  const answers = parseJson(draft.answers, 'the scripted answers', problems)
  const world = parseJson(draft.world, 'the world', problems) as ScenarioWorld | undefined
  const within = {
    ...(parseCount(draft.rounds, 'the round limit', problems) !== undefined ? { rounds: Number(draft.rounds) } : {}),
    ...(parseCount(draft.toolCalls, 'the tool call limit', problems) !== undefined ? { toolCalls: Number(draft.toolCalls) } : {}),
    ...(parseCount(draft.totalTokens, 'the token limit', problems) !== undefined ? { totalTokens: Number(draft.totalTokens) } : {}),
  }

  if (draft.provokesTool.trim() && !draft.provokesWhen.trim()) problems.push('a provoked failure has to say when it happens')
  if (!draft.provokesTool.trim() && draft.provokesWhen.trim()) problems.push('a provoked failure has to name the tool that fails')

  const expect: ScenarioExpectations = {
    ...(draft.outcome.trim() ? { outcome: draft.outcome.trim() } : {}),
    ...(listOf(draft.toolsCalled).length > 0 ? { toolsCalled: listOf(draft.toolsCalled) } : {}),
    ...(listOf(draft.toolsNotCalled).length > 0 ? { toolsNotCalled: listOf(draft.toolsNotCalled) } : {}),
    ...(listOf(draft.toolsInOrder).length > 0 ? { toolsInOrder: listOf(draft.toolsInOrder) } : {}),
    ...(Object.keys(within).length > 0 ? { within } : {}),
    ...(draft.provokesTool.trim() && draft.provokesWhen.trim()
      ? { provokes: { tool: draft.provokesTool.trim(), when: draft.provokesWhen.trim(), then: draft.provokesThen } }
      : {}),
    ...(draft.savedProcedure.trim()
      ? { saved: { procedure: draft.savedProcedure.trim(), stored: draft.savedStored === 'yes' } }
      : {}),
  }

  if (Object.keys(expect).length === 0) problems.push('the scenario has to expect something')
  if (problems.length > 0) return { problems }

  const fullWorld: ScenarioWorld = {
    ...(world ?? {}),
    ...(draft.acceptProposedWork ? { acceptProposedWork: true } : {}),
  }

  return {
    scenario: {
      id: draft.id.trim(),
      name: draft.name.trim(),
      describe: draft.describe.trim(),
      agent: draft.agent.trim(),
      procedure: { id: draft.procedure.trim(), ...(draft.version.trim() ? { version: draft.version.trim() } : {}) },
      input: { message: draft.message, ...(inputs ? { inputs } : {}) },
      ...(Object.keys(fullWorld).length > 0 ? { world: fullWorld } : {}),
      ...(answers ? { answers } : {}),
      ...(draft.approvals === 'refuse' ? { approvals: 'refuse' as const } : {}),
      expect,
    },
  }
}
