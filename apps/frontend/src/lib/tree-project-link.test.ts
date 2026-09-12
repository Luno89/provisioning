import { describe, it, expect } from 'vitest'
import { findLinkedProject } from './tree-project-link.js'

const project = (over: Partial<{ id: string; name: string }> = {}) => ({ id: 'p1', name: 'widget', ...over })

describe('findLinkedProject', () => {
  it('is undefined when there is no tree', () => {
    expect(findLinkedProject(undefined, [project()])).toBeUndefined()
  })

  it('matches via projectIds', () => {
    const tree = { name: 'something-else', projectIds: ['p1'] }
    expect(findLinkedProject(tree, [project()])?.id).toBe('p1')
  })

  it('falls back to a name match when projectIds does not include it', () => {
    const tree = { name: 'widget', projectIds: [] }
    expect(findLinkedProject(tree, [project()])?.id).toBe('p1')
  })

  it('falls back to a name match when projectIds is absent entirely', () => {
    const tree = { name: 'widget' }
    expect(findLinkedProject(tree, [project()])?.id).toBe('p1')
  })

  it('is undefined when neither projectIds nor name match', () => {
    const tree = { name: 'nope', projectIds: ['other'] }
    expect(findLinkedProject(tree, [project()])).toBeUndefined()
  })

  it('prefers whichever project matches first in the list', () => {
    const tree = { name: 'widget', projectIds: ['p2'] }
    const projects = [project({ id: 'p2', name: 'unrelated' }), project({ id: 'p1', name: 'widget' })]
    expect(findLinkedProject(tree, projects)?.id).toBe('p2')
  })
})
