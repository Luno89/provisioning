import { describe, it, expect } from 'vitest'
import { draftOf, emptyDraft, scenarioFromDraft } from './scenario-draft'
import type { Scenario } from '../api/evals'

const scenario: Scenario = {
  id: 'executor-does-one-task',
  name: 'The executor finishes a task',
  describe: 'It should claim the task and record it done.',
  agent: 'executor',
  procedure: { id: 'do-one-task' },
  input: { message: 'Do the task you have been given.', inputs: { item: { id: 'write-greeting' } } },
  world: {
    tasks: [{ id: 'write-greeting', title: 'Write hello.txt', doneMeans: 'hello.txt says hello', status: 'accepted' }],
    acceptProposedWork: true,
  },
  answers: { review: 'Carry on.' },
  expect: {
    outcome: 'ok',
    toolsInOrder: ['start_task', 'mark_done'],
    within: { rounds: 8 },
  },
}

const filled = () => draftOf(scenario)

describe('editing a scenario as a form', () => {
  it('round-trips a scenario through the form and back', () => {
    const outcome = scenarioFromDraft(filled())

    expect(outcome).toEqual({ scenario })
  })

  it('keeps accept-proposed-work as its own switch rather than raw world JSON', () => {
    const draft = filled()

    expect(draft.acceptProposedWork).toBe(true)
    expect(draft.world).not.toContain('acceptProposedWork')
  })

  it('reads tool lists as commas and writes them back as a list', () => {
    const outcome = scenarioFromDraft({ ...filled(), toolsInOrder: 'start_task,  mark_done ' })

    expect(outcome).toHaveProperty('scenario')
    expect('scenario' in outcome && outcome.scenario.expect.toolsInOrder).toEqual(['start_task', 'mark_done'])
  })

  it('refuses an id that is not lower-case dashes', () => {
    const outcome = scenarioFromDraft({ ...filled(), id: 'Does One Task' })

    expect(outcome).toEqual({ problems: ['the id has to be lower-case words joined by dashes'] })
  })

  it('says which JSON field could not be read', () => {
    const outcome = scenarioFromDraft({ ...filled(), answers: '{oops' })

    expect('problems' in outcome && outcome.problems[0]).toContain('the scripted answers is not valid JSON')
  })

  it('refuses a world that is not an object', () => {
    const outcome = scenarioFromDraft({ ...filled(), world: '[1, 2]' })

    expect('problems' in outcome && outcome.problems[0]).toBe('the world has to be a JSON object')
  })

  it('refuses a round limit that is not a count', () => {
    const outcome = scenarioFromDraft({ ...filled(), rounds: '0' })

    expect('problems' in outcome && outcome.problems[0]).toContain('the round limit')
  })

  it('refuses a provoked failure that names a tool but no failure', () => {
    const outcome = scenarioFromDraft({ ...filled(), provokesTool: 'read_procedure' })

    expect('problems' in outcome && outcome.problems[0]).toContain('has to say when it happens')
  })

  it('insists an empty scenario expects something', () => {
    const outcome = scenarioFromDraft({
      ...emptyDraft('executor'),
      id: 'blank',
      name: 'Blank',
      describe: 'Nothing at all.',
      procedure: 'tool-rounds',
      message: 'Hello.',
      outcome: '',
    })

    expect('problems' in outcome && outcome.problems).toContain('the scenario has to expect something')
  })
})

describe('what a scenario expects to be left in the store', () => {
  it('round-trips a procedure that has to be stored and check clean', () => {
    const asked: Scenario = { ...scenario, expect: { ...scenario.expect, saved: { procedure: 'tidy', stored: true } } }

    expect(scenarioFromDraft(draftOf(asked))).toEqual({ scenario: asked })
  })

  it('round-trips one that must not be stored at all', () => {
    const asked: Scenario = { ...scenario, expect: { ...scenario.expect, saved: { procedure: 'tidy', stored: false } } }

    expect(scenarioFromDraft(draftOf(asked))).toEqual({ scenario: asked })
  })

  it('expects nothing about the store when no procedure is named', () => {
    const outcome = scenarioFromDraft({ ...draftOf(scenario), savedProcedure: '  ' })

    expect('scenario' in outcome && outcome.scenario.expect.saved).toBeUndefined()
  })
})
