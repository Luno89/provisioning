import { describe, it, expect } from 'vitest'
import type { ItemChange } from '@koala/harness-types'
import { changeHeading, editRows } from './item-change'

const before = [{ leafId: 'l1', title: 'Note on screen', status: 'running', body: 'The form shows it', dependsOn: ['l0'], tasks: [{ id: 'k1', title: 'Show it', status: 'running' }] }]
const base = { treeId: 't1', why: 'print it', before, outcome: [], names: { l0: 'The field', l2: 'Printed order' } }

describe('what a change card says', () => {
  it('names a change, a rework, an addition and a cancel by the stories they touch', () => {
    expect(changeHeading({ ...base, edit: { leafId: 'l1', body: 'new' } })).toBe('Change “Note on screen”')
    expect(changeHeading({ ...base, edit: { leafId: 'l1', rework: true } })).toBe('Rework “Note on screen”')
    expect(changeHeading({ ...base, add: { branchId: 'b1', branchTitle: 'The field', leaves: [{ key: 'a', title: 'Mail it', body: 'b', brief: 'c', dependsOn: [], tasks: [] }] } })).toBe('Add “Mail it” to “The field”')
    expect(changeHeading({ ...base, cancel: ['l1'] })).toBe('Cancel “Note on screen”')
  })

  it('shows what each part of a story was and becomes, with stories by their titles', () => {
    const change: ItemChange = { ...base, edit: { leafId: 'l1', body: 'The form and the print show it', dependsOn: ['l0', 'l2'], dropTasks: ['k1'], rework: true } }
    expect(editRows(change)).toEqual([
      { label: 'Goal', before: 'The form shows it', after: 'The form and the print show it' },
      { label: 'Waits on', before: 'The field', after: 'The field, Printed order' },
      { label: 'Drop task', after: 'Show it (running)' },
      { label: 'Rework', after: 'Work it again' },
    ])
  })
})
