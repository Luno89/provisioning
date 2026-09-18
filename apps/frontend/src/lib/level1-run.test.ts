import { describe, it, expect } from 'vitest'
import { attemptsOf, outcomeOf, outcomesOf, promptHashes, runLabel, summaryOf } from './level1-run'
import type { AttemptRecord, CaseResult, EvalCase, Level1Run } from '../api/evals'

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  attempt: 0,
  passed: true,
  toolsOffered: ['read_procedure'],
  content: '',
  thinking: '',
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  latencyMs: 400,
  ...over,
})

const result = (over: Partial<CaseResult> = {}): CaseResult => ({
  name: 'read/by-name',
  category: 'simple',
  agent: 'agent-builder',
  expects: 'read_procedure',
  attempts: [],
  ...over,
})

const run = (over: Partial<Level1Run> = {}): Level1Run => ({
  id: 'run-1',
  state: 'done',
  startedAt: '2026-09-17T10:00:00.000Z',
  repeats: 3,
  toolCatalogueHash: 'abc',
  cases: ['read/by-name'],
  finished: 1,
  results: [],
  summary: { reliability: { cases: 1, always: 1, never: 0, flaky: 0 }, tools: [] },
  ...over,
})

describe('turning a level 1 run into what the tree shows', () => {
  it('counts an attempt that passed and keeps every complaint', () => {
    const outcome = outcomeOf(result({
      attempts: [
        attempt(),
        attempt({ attempt: 1, passed: false, complaint: 'called nothing' }),
        attempt({ attempt: 2, passed: false, complaint: 'called save_procedure' }),
      ],
    }))

    expect(outcome).toEqual({
      name: 'read/by-name',
      category: 'simple',
      attempts: 3,
      passed: 1,
      complaints: ['called nothing', 'called save_procedure'],
    })
  })

  it('has no outcomes at all before a run exists', () => {
    expect(outcomesOf(undefined)).toEqual([])
  })

  it('names the tool a case expects so the tree can show it', () => {
    const entry: EvalCase = {
      name: 'read/by-name',
      category: 'simple',
      agent: 'agent-builder',
      say: 'Show me the research procedure.',
      expect: { tool: 'read_procedure' },
    }

    expect(summaryOf(entry)).toEqual({
      name: 'read/by-name',
      category: 'simple',
      agent: 'agent-builder',
      say: 'Show me the research procedure.',
      expects: 'read_procedure',
    })
  })

  it('collects each distinct system prompt once, in a stable order', () => {
    const hashes = promptHashes(run({
      results: [
        result({ attempts: [attempt({ systemHash: 'bbb' }), attempt({ systemHash: 'aaa' })] }),
        result({ name: 'other', attempts: [attempt({ systemHash: 'bbb' }), attempt()] }),
      ],
    }))

    expect(hashes).toEqual(['aaa', 'bbb'])
  })

  it('finds the attempts of one case and nothing for a case that did not run', () => {
    const one = run({ results: [result({ attempts: [attempt()] })] })

    expect(attemptsOf(one, 'read/by-name')).toHaveLength(1)
    expect(attemptsOf(one, 'never/ran')).toEqual([])
  })
})

describe('labelling a past run', () => {
  it('says what it ran against and how it stood', () => {
    const label = runLabel(run({
      modelLabel: 'Tabbyapi-Production',
      sampling: { toolTurn: { temperature: 0.2 } },
      summary: { reliability: { cases: 4, always: 3, never: 1, flaky: 0 }, tools: [] },
      cases: ['a', 'b', 'c', 'd'],
      finished: 4,
    }))

    expect(label).toContain('Tabbyapi-Production')
    expect(label).toContain('T=0.2')
    expect(label).toContain('4/4')
    expect(label).toContain('3 solid, 0 flaky, 1 broken')
  })

  it('falls back to the state while a run has no summary yet', () => {
    expect(runLabel(run({ state: 'running', summary: undefined as never }))).toContain('(running)')
  })
})
