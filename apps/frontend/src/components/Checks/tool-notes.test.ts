import { describe, it, expect } from 'vitest'
import type { ToolNote } from '../../api/evals'
import { describeNotes, noteAbout, noteTrial, notesIn } from './tool-notes'

const note = (id: string, over: Partial<ToolNote>): ToolNote => ({ id, title: id, text: id, createdAt: 'a', updatedAt: 'a', ...over })

describe('tool notes', () => {
  const notes = [
    note('builtin', { tool: 'start_task' }),
    note('click', { server: 'playwright', tool: 'browser_click' }),
    note('server', { server: 'playwright' }),
  ]

  it('belong to a tool by the name it is offered under, and to a server with every note on its tools', () => {
    expect(notesIn(notes, { tool: 'start_task' }).map((entry) => entry.id)).toEqual(['builtin'])
    expect(notesIn(notes, { tool: 'playwright__browser_click' }).map((entry) => entry.id)).toEqual(['click'])
    expect(notesIn(notes, { server: 'playwright' }).map((entry) => entry.id)).toEqual(['click', 'server'])
  })

  it('are summed up by where they stand', () => {
    expect(describeNotes([])).toBe('nothing learned yet')
    expect(describeNotes([{ status: 'active' }, {}, { status: 'pending_review' }])).toBe('2 live · 1 held for you')
  })

  it('say what they are about', () => {
    expect(notes.map(noteAbout)).toEqual(['start_task', 'browser_click', 'every tool of playwright'])
  })

  it('say how their trial went, and which checks they made pass', () => {
    expect(noteTrial(note('n', { trial: { checkedAt: 'a', unchecked: true } }))).toBe('not tried — no check uses this tool yet')
    expect(noteTrial(note('n', { trial: { checkedAt: 'a', runId: 'r1', scenarios: ['x'], regressions: ['x'] } }))).toBe('regressed x in bench run r1')
    expect(noteTrial(note('n', { trial: { checkedAt: 'a', scenarios: ['x', 'y'], regressions: [], better: ['y'] } }))).toBe('nothing regressed across 2 checks, and y now passes')
    expect(noteTrial(note('n', { trial: { checkedAt: 'a', scenarios: ['x'], regressions: [] } }))).toBe('nothing regressed across 1 check, but no check that failed before passed')
  })
})
