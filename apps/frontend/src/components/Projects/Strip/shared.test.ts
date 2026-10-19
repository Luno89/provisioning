import { describe, expect, it } from 'vitest'
import type { TreeModelRow } from '../../../api/grove'
import { runsOnLine, wholeTreeChanges, workingOn } from './shared'

const row = (agent: string, over: Partial<TreeModelRow> = {}): TreeModelRow => ({ agent, name: agent[0]!.toUpperCase() + agent.slice(1), own: { modelId: 'tabby' }, ...over })
const nameOf = (id: string) => ({ 'machine:desk:antigravity': 'Antigravity · Desk', tabby: 'Tabby', qwen: 'Qwen' }[id] ?? id)

describe('what a tree runs on, in a line', () => {
  it('names the agents moved off their own model, and says the rest keep theirs', () => {
    expect(runsOnLine([row('executor'), row('judge')], nameOf).label).toBe('Each agent on its own model')
    expect(runsOnLine([row('executor', { chosen: { modelId: 'machine:desk:antigravity' } }), row('judge')], nameOf).label).toBe('Executor on Antigravity · Desk · the rest on their own')
    expect(runsOnLine([row('executor', { chosen: { modelId: 'qwen' } }), row('judge', { chosen: { modelId: 'qwen' } })], nameOf).label).toBe('Every agent on Qwen')
    expect(runsOnLine([row('executor', { chosen: { modelId: 'qwen' } }), row('judge', { chosen: { modelId: 'tabby' } })], nameOf).label).toBe('Executor on Qwen · Judge on Tabby')
    expect(runsOnLine([row('executor', { chosen: { modelId: 'gone', gone: true } })], nameOf).label).toBe('Each agent on its own model')
  })
})

describe('putting every agent in a tree on one model', () => {
  it('changes only the agents that differ, leaves fixed ones, and skips machines for agents that cannot use one', () => {
    const rows = [row('executor'), row('judge', { chosen: { modelId: 'qwen' } }), row('leaf-judge', { noMachine: true }), row('release', { own: { machine: 'desk' } })]
    expect(wholeTreeChanges(rows, 'qwen')).toEqual({ changes: [{ agent: 'executor', modelId: 'qwen' }, { agent: 'leaf-judge', modelId: 'qwen' }], skipped: [] })
    expect(wholeTreeChanges(rows, 'machine:desk:antigravity')).toEqual({
      changes: [{ agent: 'executor', modelId: 'machine:desk:antigravity' }, { agent: 'judge', modelId: 'machine:desk:antigravity' }],
      skipped: ['Leaf-judge'],
    })
    expect(wholeTreeChanges(rows, null)).toEqual({ changes: [{ agent: 'judge', modelId: null }], skipped: [] })
  })

  it('lists the stories being worked', () => {
    expect(workingOn([{ title: 'A', status: 'running' }, { title: 'B', status: 'pending' }, { title: 'C', status: 'claimed' }])).toEqual(['A', 'C'])
  })
})
