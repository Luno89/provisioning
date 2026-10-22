import { describe, it, expect } from 'vitest'
import { joinProjectRows } from './shared.js'

const tree = (over: Partial<{ id: string; name: string; projectIds: string[] }> = {}) =>
  ({ id: 't1', name: 'widget', ...over })

const project = (over: Partial<{ id: string; name: string }> = {}) =>
  ({ id: 'p1', name: 'widget', giteaOwner: 'acme', giteaRepo: 'widget', ...over })

describe('joinProjectRows', () => {
  it('gives every tree a row, linked project attached when found', () => {
    const rows = joinProjectRows([tree({ projectIds: ['p1'] })], [project()])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 't1', tree: { id: 't1' }, project: { id: 'p1' } })
  })

  it('gives a tree with no linked project a row with no project field', () => {
    const rows = joinProjectRows([tree({ projectIds: [] })], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.project).toBeUndefined()
  })

  it('a project with an unrelated name and no projectIds match gets its own separate row', () => {
    const rows = joinProjectRows([tree({ projectIds: [] })], [project({ id: 'p2', name: 'unrelated' })])
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.tree)?.project).toBeUndefined()
    expect(rows.find((r) => !r.tree)?.project?.id).toBe('p2')
  })

  it('appends a project-only row for a project no tree claims', () => {
    const rows = joinProjectRows([], [project()])
    expect(rows).toEqual([{ id: 'p1', name: 'widget', project: project() }])
  })

  it('does not double-count a project already claimed by a tree', () => {
    const rows = joinProjectRows([tree({ projectIds: ['p1'] })], [project()])
    expect(rows).toHaveLength(1)
    expect(rows.filter((r) => r.project?.id === 'p1')).toHaveLength(1)
  })

  it('matches via name when projectIds does not include it, same as the tree workspace', () => {
    const rows = joinProjectRows([tree({ projectIds: [] })], [project()])
    expect(rows[0]!.project?.id).toBe('p1')
  })

  it('mixes tree rows and project-only rows together', () => {
    const rows = joinProjectRows(
      [tree({ id: 't1', name: 'widget', projectIds: ['p1'] })],
      [project({ id: 'p1', name: 'widget' }), project({ id: 'p2', name: 'standalone' })],
    )
    expect(rows.map((r) => r.id).sort()).toEqual(['p2', 't1'])
  })
})
