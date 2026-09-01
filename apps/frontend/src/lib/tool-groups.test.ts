import { describe, it, expect } from 'vitest'
import {
  groupTools, groupState, toggleGroup, toggleTool, categoryLabel, CATEGORY_ORDER,
} from './tool-groups'

const tool = (name: string, category: string) => ({ name, category })

describe('groupTools', () => {
  it('orders known categories by the declared order, not by encounter', () => {
    const groups = groupTools([tool('a', 'git'), tool('b', 'assistant'), tool('c', 'web')])
    expect(groups.map((g) => g.key)).toEqual(['assistant', 'web', 'git'])
  })

  it('keeps a category the order does not know, after the ones it does', () => {
    const groups = groupTools([tool('a', 'zzz-new'), tool('b', 'assistant')])
    expect(groups.map((g) => g.key)).toEqual(['assistant', 'zzz-new'])
  })

  it('files a tool with no category under custom', () => {
    const groups = groupTools([{ name: 'a', category: '' }])
    expect(groups).toEqual([{ key: 'custom', label: 'Custom', tools: [{ name: 'a', category: '' }] }])
  })

  it('emits no group for a category with no tools', () => {
    expect(groupTools([tool('a', 'git')]).map((g) => g.key)).toEqual(['git'])
  })

  it('labels every category it ships an order for', () => {
    for (const key of CATEGORY_ORDER) expect(categoryLabel(key)).not.toBe(key)
  })
})

describe('groupState', () => {
  const tools = [tool('a', 'git'), tool('b', 'git')]

  it('reads none, some and all', () => {
    expect(groupState(tools, [])).toBe('none')
    expect(groupState(tools, ['a'])).toBe('some')
    expect(groupState(tools, ['a', 'b'])).toBe('all')
  })

  it('ignores selections from other groups', () => {
    expect(groupState(tools, ['a', 'b', 'elsewhere'])).toBe('all')
  })

  it('calls an empty group none rather than all', () => {
    expect(groupState([], [])).toBe('none')
  })
})

describe('toggleGroup', () => {
  const tools = [tool('a', 'git'), tool('b', 'git')]

  it('grants the whole group in one press', () => {
    expect(toggleGroup([], tools).sort()).toEqual(['a', 'b'])
  })

  it('revokes the whole group when it was fully granted', () => {
    expect(toggleGroup(['a', 'b'], tools)).toEqual([])
  })

  it('fills a partly-granted group in rather than clearing it', () => {
    expect(toggleGroup(['a'], tools).sort()).toEqual(['a', 'b'])
  })

  it('leaves selections from other groups alone', () => {
    expect(toggleGroup(['elsewhere'], tools).sort()).toEqual(['a', 'b', 'elsewhere'])
    expect(toggleGroup(['a', 'b', 'elsewhere'], tools)).toEqual(['elsewhere'])
  })

  it('never duplicates a name already granted', () => {
    const out = toggleGroup(['a'], tools)
    expect(out.filter((n) => n === 'a')).toHaveLength(1)
  })
})

describe('toggleTool', () => {
  it('adds and removes one grant', () => {
    expect(toggleTool([], 'a')).toEqual(['a'])
    expect(toggleTool(['a', 'b'], 'a')).toEqual(['b'])
  })
})
