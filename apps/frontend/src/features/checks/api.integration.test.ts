import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type AgentChange, type BenchSettings, type Level2Run, type BenchState, type CoverageGap, type Practice, type Scenario, type ScenarioProposal, type ToolNote,
  cancelLevel2Run, compareCheckRuns, deleteScenario, dismissChange, dismissProposal, getBench, getCheckProcedure, getCoverage, getLevel2Run, listChanges,
  listLevel2Runs, listPractices, listProposals, listScenarios, listToolNotes, makePracticeLive, makeToolNoteLive, retirePractice, retireToolNote, saveBench,
  saveScenario, startLevel2Run, acceptProposal,
} from './api'
import { startBackend } from '../../test/backend/site'
import { projectsOf, type ProjectsSide } from '../../test/backend/projects'
import { outsideThisTier } from '../../test/backend/outside'
import type { Wire } from '../../test/backend/wire'
import { anyOf, objectWith } from '../../../../backend/src/platform/lib/test-matchers'
import { evalsLevel2Router } from '../../../../backend/src/checks/routes/evals-level2'
import { Level2Service, checkRunWorkflowId, temporalCheckRunner } from '../../../../backend/src/checks/services/Level2Service'
import { BenchService } from '../../../../backend/src/checks/services/BenchService'
import { PracticeService } from '../../../../backend/src/memory/services/PracticeService'
import { AgentChangeService } from '../../../../backend/src/engine/services/AgentChangeService'
import { createStoredToolCatalogue } from '../../../../backend/src/engine-host/registries/tool-catalogue-store'
import type { Scenario as BackendScenario } from '../../../../backend/src/eval/level2/scenario'
import type { BenchSettings as BackendBenchSettings, BenchState as BackendBenchState } from '../../../../backend/src/checks/lib/bench'
import type { CoverageGap as BackendGap } from '../../../../backend/src/checks/lib/check-coverage'
import type { ScenarioProposal as BackendProposal } from '../../../../backend/src/checks/lib/scenario-proposals'
import type { AgentChange as BackendChange } from '../../../../backend/src/engine/lib/agent-changes'
import type { Level2Run as BackendLevel2Run } from '../../../../backend/src/checks/services/Level2Service'
import type { MemoryItem } from '../../../../backend/src/memory/lib/memory-store'
import { standInMemoryIndex } from '../../test/backend/memory-index'
import { grantsActingAsOwner } from '../../../../backend/src/engine/testing/run-grants'

let side: ProjectsSide | undefined
const idleTimers: { ownerId: string; idleMs: number }[] = []

const backend = await startBackend(async (site) => {
  side = await projectsOf(site)
  const { db } = site
  const catalogue = createStoredToolCatalogue({ tools: { list: (ownerId) => db.engine.getEngineTools(ownerId) } })
  const level2 = new Level2Service({
    checks: temporalCheckRunner(() => side!.temporal.client, 'engine-ops-queue'),
    tools: (ownerId) => catalogue.list(ownerId),
    agents: async (ownerId) => (await side!.registry.agents(ownerId)).map((agent) => agent.slug),
    procedures: async (ownerId) => (await side!.registry.procedures(ownerId)).map((procedure) => procedure.id),
    store: db.checks,
    ...grantsActingAsOwner(db.engine),
  })
  const indexing = standInMemoryIndex()
  const practices = new PracticeService({ store: db.memory, indexing })
  const notes = new PracticeService({ store: db.memory, indexing, category: 'tool_note' })
  const changes = new AgentChangeService({
    store: db.checks,
    savePrompt: () => { throw new Error('saving an agent\'s prompt is the Studio\'s, not mounted in this file') },
    handOff: () => { throw new Error('handing a procedure change to the agent builder starts a run, not mounted in this file') },
  })
  const bench = new BenchService({
    store: db,
    scenarios: async (ownerId) => (await level2.scenarios(ownerId)).map((scenario) => ({ id: scenario.id, agent: scenario.agent, onBench: scenario.onBench })),
    fingerprints: async () => ({}),
    practices,
    notes,
    changes,
    earlier: (run) => level2.earlier(run),
    notifyChange: () => undefined,
    start: () => { throw new Error('the bench starting on its own is not what this file proves') },
    serving: async () => undefined,
    benchRunning: async (ownerId) => (await level2.list(ownerId)).some((run) => run.state === 'running'),
    agentsRunning: outsideThisTier<{ run: () => Promise<boolean> }>('Temporal\'s workflow list').run,
    idleTimer: async (ownerId, idleMs) => { idleTimers.push({ ownerId, idleMs }) },
    notify: () => undefined,
  })
  site.api.use('/evals/level2', evalsLevel2Router({ level2, bench, practices, notes, changes }))
})

const owner = await backend.signIn()
const now = new Date().toISOString()

const ownCheck: Scenario = {
  id: 'my-check',
  name: 'Koala answers about the GPU',
  describe: 'Asked about the GPU, it answers.',
  agent: 'koala',
  procedure: { id: 'interactive-chat' },
  input: { message: 'Is my GPU busy?' },
  expect: { outcome: 'ok' },
} as Scenario

expectTypeOf<Wire<BackendScenario>>().toExtend<Scenario>()
expectTypeOf<Wire<BackendLevel2Run>>().toExtend<Level2Run>()
expectTypeOf<Wire<BackendBenchSettings>>().toExtend<BenchSettings>()
expectTypeOf<Wire<BackendBenchState>>().toExtend<BenchState>()
expectTypeOf<Wire<BackendGap>>().toExtend<CoverageGap>()
expectTypeOf<Wire<BackendProposal>>().toExtend<ScenarioProposal>()
expectTypeOf<Wire<BackendChange>>().toExtend<AgentChange>()
expectTypeOf<Wire<MemoryItem>>().toExtend<Practice>()
expectTypeOf<Wire<MemoryItem>>().toExtend<ToolNote>()

describe('checks, as the Studio asks for them', () => {
  it('lists the shipped checks', async () => {
    const checks = await listScenarios()
    expect(checks.length).toBeGreaterThan(0)
    expect(checks[0]).toMatchObject({ id: anyOf(String), name: anyOf(String), agent: anyOf(String) })
  })

  it('saves a check of the person\'s own and lists it', async () => {
    expect(await saveScenario(ownCheck)).toMatchObject({ id: 'my-check', agent: 'koala' })
    expect((await listScenarios()).find((check) => check.id === 'my-check')).toMatchObject({ name: 'Koala answers about the GPU' })
  })

  it('refuses a check whose agent does not exist, with its problems', async () => {
    await expect(saveScenario({ ...ownCheck, agent: 'nobody-agent' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'The scenario has problems', problems: anyOf(Array) } } })
  })

  it('says a check that runs a stored procedure has none made for it', async () => {
    await expect(getCheckProcedure('my-check')).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('reads the coverage gaps as a list', async () => {
    expect(Array.isArray(await getCoverage())).toBe(true)
  })

  it('starts a run of one check, which starts the check runner, and lists and reads it', async () => {
    const run = await startLevel2Run({ only: ['my-check'] })
    expect(run).toMatchObject({ id: anyOf(String), state: 'running', scenarios: ['my-check'], results: [] })
    expect(side!.temporal.workflows.get(checkRunWorkflowId(run.id))).toMatchObject({ workflowType: 'CheckRunWorkflow', status: 'RUNNING' })
    expect(await listLevel2Runs()).toEqual([objectWith({ id: run.id, state: 'running' })])
    expect(await getLevel2Run(run.id)).toMatchObject({ id: run.id })
    await cancelLevel2Run(run.id)
    expect(side!.temporal.workflows.get(checkRunWorkflowId(run.id))?.signals).toEqual([{ name: 'cancelCheck', args: [] }])
  })

  it('refuses a run of a check that does not exist, and reading a run that does not exist', async () => {
    await expect(startLevel2Run({ only: ['nothing-here'] })).rejects.toMatchObject({ response: { status: 400, data: { error: 'there is no scenario called "nothing-here"' } } })
    await expect(getLevel2Run('nothing-here')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(cancelLevel2Run('nothing-here')).rejects.toMatchObject({ response: { status: 409, data: { error: 'That run is not running' } } })
    await expect(compareCheckRuns('nothing', 'here')).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('deletes the person\'s own check, and refuses a shipped one', async () => {
    await deleteScenario('my-check')
    expect((await listScenarios()).some((check) => check.id === 'my-check')).toBe(false)
    const [shipped] = await listScenarios()
    await expect(deleteScenario(shipped!.id)).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no scenario of your own with that id' } } })
  })
})

describe('the bench', () => {
  it('reads its settings and state and saves new settings', async () => {
    const { settings, state } = await getBench()
    expect(settings).toEqual({ enabled: anyOf(Boolean), idleMinutes: anyOf(Number), fullEveryHours: anyOf(Number) })
    expect(state).toMatchObject({ benched: anyOf(Object) })
    expect(await saveBench({ ...settings, idleMinutes: settings.idleMinutes + 5 })).toMatchObject({ idleMinutes: settings.idleMinutes + 5 })
    expect(idleTimers.at(-1)).toEqual({ ownerId: owner.id, idleMs: (settings.idleMinutes + 5) * 60_000 })
  })

  it('refuses settings it cannot use', async () => {
    await expect(saveBench({ enabled: true, idleMinutes: -1, fullEveryHours: 1 })).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe('what the memory keeper proposes', () => {
  it('lists a proposed check, and accepts it as a check of the person\'s own', async () => {
    await backend.db.checks.saveEvalRecord('evalScenarioProposals', { id: 'proposal-1', ownerId: owner.id, scenario: { ...ownCheck, id: 'proposed-check' }, why: 'Koala got this wrong once', status: 'proposed', createdAt: now })
    expect(await listProposals()).toEqual([objectWith({ id: 'proposal-1', status: 'proposed', why: 'Koala got this wrong once' })])
    expect(await acceptProposal('proposal-1')).toMatchObject({ id: 'proposed-check' })
    await expect(dismissProposal('proposal-1')).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('lists practices and tool notes, and makes one live and retires another', async () => {
    await backend.db.memory.saveMemory({ id: 'practice-1', ownerId: owner.id, category: 'practice', agent: 'koala', title: 'Say which GPU', text: 'Name the GPU you mean.', status: 'pending_review', createdAt: now, updatedAt: now } as MemoryItem)
    await backend.db.memory.saveMemory({ id: 'note-1', ownerId: owner.id, category: 'tool_note', tool: 'run_command', title: 'Quote paths', text: 'Quote paths with spaces.', status: 'pending_review', createdAt: now, updatedAt: now } as MemoryItem)
    expect(await listPractices()).toEqual([objectWith({ id: 'practice-1', title: 'Say which GPU' })])
    expect(await listToolNotes()).toEqual([objectWith({ id: 'note-1', tool: 'run_command' })])
    await makePracticeLive('practice-1')
    await retireToolNote('note-1')
    expect(await listPractices()).toEqual([objectWith({ id: 'practice-1', status: 'active' })])
    await expect(makeToolNoteLive('note-1')).rejects.toMatchObject({ response: { status: 404 } })
    await retirePractice('practice-1')
  })

  it('lists no agent changes, and refuses to dismiss one that is not waiting', async () => {
    expect(await listChanges()).toEqual([])
    await expect(dismissChange('nothing')).rejects.toMatchObject({ response: { status: 404, data: { error: 'there is no change waiting with that id' } } })
  })

  it('dismisses a change waiting for them, which then shows as dismissed and is not dismissed twice', async () => {
    const waiting: BackendChange = { id: 'change-1', ownerId: owner.id, kind: 'prompt', agent: 'koala', why: 'it named the wrong GPU', status: 'ready', prompt: 'Name the GPU.', currentPrompt: 'Answer.', createdAt: now }
    await backend.db.checks.saveEvalRecord('evalAgentChanges', waiting)
    await dismissChange('change-1')
    expect(await listChanges()).toEqual([objectWith({ id: 'change-1', status: 'dismissed', decidedAt: expect.any(String) })])
    await expect(dismissChange('change-1')).rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('another person', () => {
  it('sees none of the first person\'s checks, runs, practices or proposals', async () => {
    await backend.signInAnother('second@koala.test')
    expect((await listScenarios()).some((check) => check.id === 'proposed-check')).toBe(false)
    expect(await listLevel2Runs()).toEqual([])
    expect(await listPractices()).toEqual([])
    expect(await listProposals()).toEqual([])
  })
})
