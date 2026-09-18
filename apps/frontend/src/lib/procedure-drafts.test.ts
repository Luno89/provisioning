import { describe, it, expect } from 'vitest'
import { RESEARCH_V2, type ProcedureProblem, type StringSetting } from '@koala/agent-engine/procedure'
import { blankProcedure, copyOf, starterProcedure, defaultFor, groupPathIn, localProblems, mergeProblems, procedureIdFrom, withBudget } from './procedure-drafts'

describe('starting values for settings', () => {
  it('uses a setting\'s own default, else the first choice, else an empty value of the right kind', () => {
    expect(defaultFor({ type: 'string', default: 'hi' })).toBe('hi')
    expect(defaultFor({ type: 'string', enum: ['auto', 'none'] } satisfies StringSetting)).toBe('auto')
    expect(defaultFor({ type: 'integer', minimum: 1 })).toBe(1)
    expect(defaultFor({ type: 'boolean' })).toBe(false)
    expect(defaultFor({ type: 'array', items: { type: 'string' } })).toEqual([])
    expect(defaultFor({ type: 'object', properties: { name: { type: 'string', default: 'x' } } })).toEqual({ name: 'x' })
  })
})

describe('new procedures', () => {
  it('makes an id from a name', () => {
    expect(procedureIdFrom('  My Research: v2! ')).toBe('my-research-v2')
  })

  it('starts empty, and says it has no start', () => {
    expect(localProblems(blankProcedure('fresh', 'Fresh')).map((problem) => problem.message)).toContain('the start node "" does not exist')
  })

  it('can start from a procedure that already checks clean, so it can be saved straight away', () => {
    const starter = starterProcedure('fresh', 'Fresh')
    expect(localProblems(starter)).toEqual([])
    expect(starter.start).toBe('finish')
  })

  it('copies a procedure under a new id without sharing anything with the original', () => {
    const copy = copyOf(RESEARCH_V2, 'my-research', 'My research')
    copy.nodes[0]!.settings.changed = true

    expect(copy).toMatchObject({ id: 'my-research', name: 'My research', version: '0' })
    expect(RESEARCH_V2.nodes[0]!.settings.changed).toBeUndefined()
  })

  it('sets and clears a budget limit', () => {
    const limited = withBudget(RESEARCH_V2, 'maxTokens', 5000)
    expect(limited.budget.maxTokens).toBe(5000)
    expect(withBudget(limited, 'maxTokens', undefined).budget).toEqual(RESEARCH_V2.budget)
  })
})

describe('problems', () => {
  it('shows the server\'s problems once they arrive, keeping local ones it did not repeat', () => {
    const local: ProcedureProblem[] = [{ severity: 'error', message: 'a' }, { severity: 'warning', message: 'b', node: 'x' }]
    const server: ProcedureProblem[] = [{ severity: 'error', message: 'a' }, { severity: 'error', message: 'unknown tool', node: 'y' }]

    expect(mergeProblems(local, undefined)).toEqual(local)
    expect(mergeProblems(local, server).map((problem) => problem.message)).toEqual(['a', 'unknown tool', 'b'])
  })
})

describe('finding a node inside groups', () => {
  it('names the groups to open to reach a node the run reported', () => {
    expect(groupPathIn(RESEARCH_V2, 'turn.call')).toEqual(['model-turn'])
    expect(groupPathIn(RESEARCH_V2, 'provision')).toEqual([])
  })
})
