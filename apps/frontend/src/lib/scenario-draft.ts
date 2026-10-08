import type { Scope } from './check-subjects'
import { PLUMBING_KEYS, type ArgCheck, type CheckScript, type FlowStage, type Scenario, type ScenarioExpectations, type ScenarioWorld, type StepUnderTest } from '../api/evals'

export interface ScenarioDraft {
  id: string
  name: string
  describe: string
  agent: string
  procedure: string
  message: string
  inputs: string
  world: string
  answers: string
  approvals: 'allow' | 'refuse'
  acceptProposedWork: boolean
  outcome: string
  toolsCalled: string
  toolsNotCalled: string
  toolsSucceeded: string
  toolsInOrder: string
  rounds: string
  toolCalls: string
  totalTokens: string
  provokesTool: string
  provokesWhen: string
  provokesThen: 'retried' | 'reported'
  savedProcedure: string
  savedStored: 'yes' | 'no'
  expectedTasks: string
  handOffs: string
  files: string
  script: string
  step: string
  stages: string
  plumbing: string
  turn: boolean
  choosesTool: string
  choosesArgs: string
  repeats: string
  passAt: string
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
    message: '',
    inputs: '',
    world: '',
    answers: '',
    approvals: 'allow',
    acceptProposedWork: false,
    outcome: 'ok',
    toolsCalled: '',
    toolsNotCalled: '',
    toolsSucceeded: '',
    toolsInOrder: '',
    rounds: '',
    toolCalls: '',
    totalTokens: '',
    provokesTool: '',
    provokesWhen: '',
    provokesThen: 'reported',
    savedProcedure: '',
    savedStored: 'yes',
    expectedTasks: '',
    handOffs: '',
    files: '',
    script: '',
    step: '',
    stages: '',
    plumbing: '',
    turn: false,
    choosesTool: '',
    choosesArgs: '',
    repeats: '',
    passAt: '',
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
    message: scenario.input.message,
    inputs: jsonOf(scenario.input.inputs),
    world: jsonOf(kept),
    answers: jsonOf(scenario.answers),
    approvals: scenario.approvals ?? 'allow',
    acceptProposedWork: acceptProposedWork ?? false,
    outcome: scenario.expect.outcome ?? '',
    toolsCalled: textOf(scenario.expect.toolsCalled),
    toolsNotCalled: textOf(scenario.expect.toolsNotCalled),
    toolsSucceeded: textOf(scenario.expect.toolsSucceeded),
    toolsInOrder: textOf(scenario.expect.toolsInOrder),
    rounds: scenario.expect.within?.rounds === undefined ? '' : String(scenario.expect.within.rounds),
    toolCalls: scenario.expect.within?.toolCalls === undefined ? '' : String(scenario.expect.within.toolCalls),
    totalTokens: scenario.expect.within?.totalTokens === undefined ? '' : String(scenario.expect.within.totalTokens),
    provokesTool: scenario.expect.provokes?.tool ?? '',
    provokesWhen: scenario.expect.provokes?.when ?? '',
    provokesThen: scenario.expect.provokes?.then ?? 'reported',
    savedProcedure: scenario.expect.saved?.procedure ?? '',
    savedStored: scenario.expect.saved?.stored === false ? 'no' : 'yes',
    expectedTasks: jsonOf(scenario.expect.tasks),
    handOffs: jsonOf(scenario.expect.handOffs),
    files: jsonOf(scenario.expect.files),
    script: jsonOf(scenario.script),
    step: jsonOf(scenario.step),
    stages: jsonOf(scenario.then),
    plumbing: jsonOf(plumbingOf(scenario.expect)),
    turn: scenario.turn === true,
    choosesTool: scenario.expect.chooses?.tool ?? '',
    choosesArgs: jsonOf(scenario.expect.chooses?.args?.length ? scenario.expect.chooses.args : undefined),
    repeats: scenario.repeats === undefined ? '' : String(scenario.repeats),
    passAt: scenario.passAt === undefined ? '' : String(scenario.passAt),
  }
}

function plumbingOf(expect: ScenarioExpectations): Partial<ScenarioExpectations> | undefined {
  const picked = Object.fromEntries(PLUMBING_KEYS.filter((key) => expect[key] !== undefined).map((key) => [key, expect[key]]))
  return Object.keys(picked).length > 0 ? picked : undefined
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `stepProcedureId` in apps/backend/src/lib/step-check.ts and `TURN_PROCEDURE_ID` in
 * apps/backend/src/lib/turn-check.ts.
 */
export const stepProcedureId = (id: string): string => `step-check-${id}`
export const TURN_PROCEDURE_ID = 'turn-check'

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

const parseList = <T>(text: string, what: string, problems: string[]): T[] | undefined => {
  if (!text.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      problems.push(`${what} has to be a JSON list`)
      return undefined
    }
    return parsed as T[]
  } catch (err) {
    problems.push(`${what} is not valid JSON: ${(err as Error).message}`)
    return undefined
  }
}

export type DraftOutcome = { scenario: Scenario } | { problems: string[] }

export function scenarioFromDraft(draft: ScenarioDraft): DraftOutcome {
  const problems: string[] = []

  if (!/^[a-z0-9][a-z0-9-]*$/.test(draft.id.trim())) problems.push('the id has to be lower-case words joined by dashes')
  if (!draft.name.trim()) problems.push('the scenario needs a name')
  if (!draft.describe.trim()) problems.push('the scenario has to say what it checks')
  if (!draft.agent.trim()) problems.push('the scenario has to name the persona to run')
  if (!draft.procedure.trim() && !draft.step.trim() && !draft.turn) problems.push('the scenario has to name the procedure to run')
  if (draft.turn && draft.step.trim()) problems.push('a check is one turn or one step, not both')
  if (!draft.message.trim()) problems.push('the scenario has to say what the run is asked to do')

  const inputs = parseJson(draft.inputs, 'the extra inputs', problems)
  const answers = parseJson(draft.answers, 'the scripted answers', problems)
  const world = parseJson(draft.world, 'the world', problems) as ScenarioWorld | undefined
  const within = {
    ...(parseCount(draft.rounds, 'the round limit', problems) !== undefined ? { rounds: Number(draft.rounds) } : {}),
    ...(parseCount(draft.toolCalls, 'the tool call limit', problems) !== undefined ? { toolCalls: Number(draft.toolCalls) } : {}),
    ...(parseCount(draft.totalTokens, 'the token limit', problems) !== undefined ? { totalTokens: Number(draft.totalTokens) } : {}),
  }

  const tasks = parseList<NonNullable<ScenarioExpectations['tasks']>[number]>(draft.expectedTasks, 'the task states', problems)
  const handOffs = parseList<NonNullable<ScenarioExpectations['handOffs']>[number]>(draft.handOffs, 'the hand-offs', problems)
  const files = parseList<NonNullable<ScenarioExpectations['files']>[number]>(draft.files, 'the files', problems)
  const script = parseJson(draft.script, 'the script', problems) as CheckScript | undefined
  const step = parseJson(draft.step, 'the step', problems) as StepUnderTest | undefined
  const stages = parseList<FlowStage>(draft.stages, 'the stages', problems)
  const plumbing = parseJson(draft.plumbing, 'the plumbing checks', problems) as Partial<ScenarioExpectations> | undefined
  for (const key of Object.keys(plumbing ?? {})) {
    if (!(PLUMBING_KEYS as readonly string[]).includes(key)) problems.push(`"${key}" is not a plumbing check — one of ${PLUMBING_KEYS.join(', ')}`)
  }

  if (draft.provokesTool.trim() && !draft.provokesWhen.trim()) problems.push('a provoked failure has to say when it happens')
  if (!draft.provokesTool.trim() && draft.provokesWhen.trim()) problems.push('a provoked failure has to name the tool that fails')

  const repeats = parseCount(draft.repeats, 'repeats', problems)
  const passAt = parseCount(draft.passAt, 'pass at', problems)
  const args = parseList<ArgCheck>(draft.choosesArgs, 'the arguments to check', problems)

  const expect: ScenarioExpectations = draft.turn ? {
    chooses: { tool: draft.choosesTool.trim() || null, ...(args?.length ? { args } : {}) },
    ...(plumbing?.modelSaw ? { modelSaw: plumbing.modelSaw } : {}),
  } : {
    ...(draft.outcome.trim() ? { outcome: draft.outcome.trim() } : {}),
    ...(listOf(draft.toolsCalled).length > 0 ? { toolsCalled: listOf(draft.toolsCalled) } : {}),
    ...(listOf(draft.toolsNotCalled).length > 0 ? { toolsNotCalled: listOf(draft.toolsNotCalled) } : {}),
    ...(listOf(draft.toolsSucceeded).length > 0 ? { toolsSucceeded: listOf(draft.toolsSucceeded) } : {}),
    ...(listOf(draft.toolsInOrder).length > 0 ? { toolsInOrder: listOf(draft.toolsInOrder) } : {}),
    ...(Object.keys(within).length > 0 ? { within } : {}),
    ...(draft.provokesTool.trim() && draft.provokesWhen.trim()
      ? { provokes: { tool: draft.provokesTool.trim(), when: draft.provokesWhen.trim(), then: draft.provokesThen } }
      : {}),
    ...(draft.savedProcedure.trim()
      ? { saved: { procedure: draft.savedProcedure.trim(), stored: draft.savedStored === 'yes' } }
      : {}),
    ...(tasks?.length ? { tasks } : {}),
    ...(handOffs?.length ? { handOffs } : {}),
    ...(files?.length ? { files } : {}),
    ...(plumbing ?? {}),
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
      procedure: { id: draft.turn ? TURN_PROCEDURE_ID : step ? stepProcedureId(draft.id.trim()) : draft.procedure.trim() },
      input: { message: draft.message, ...(inputs ? { inputs } : {}) },
      ...(Object.keys(fullWorld).length > 0 ? { world: fullWorld } : {}),
      ...(answers ? { answers } : {}),
      ...(draft.approvals === 'refuse' ? { approvals: 'refuse' as const } : {}),
      ...(script ? { script } : {}),
      ...(step ? { step } : {}),
      ...(draft.turn ? { turn: true } : {}),
      ...(repeats !== undefined ? { repeats } : {}),
      ...(passAt !== undefined ? { passAt } : {}),
      expect,
      ...(stages?.length && !draft.turn ? { then: stages } : {}),
    },
  }
}

export function scopedDraft(scope: Scope, fallbackAgent: string): ScenarioDraft {
  if ('agent' in scope) return emptyDraft(scope.agent)
  if ('procedure' in scope) return { ...emptyDraft(fallbackAgent), procedure: scope.procedure }
  return { ...emptyDraft(fallbackAgent), step: JSON.stringify({ node: 'call-tool', settings: { tool: scope.tool } }, null, 2) }
}
