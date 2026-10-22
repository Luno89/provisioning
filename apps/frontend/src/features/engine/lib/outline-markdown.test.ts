import { describe, it, expect } from 'vitest'
import { outlineMarkdown, subjectOf } from './outline-markdown'

describe('an outline Koala is handed, written for a person to read', () => {
  it('keeps each line its own paragraph, bolds its labels, keeps its lists and leaves out the ids', () => {
    const story = [
      'Story "Module installs" (plan-1-b0-l0), in the feature "The field" (plan-1-b0) of tree "Shop" (t1).',
      'State: failed, landed (merged).',
      'Brief: Add delivery_instructions to sale.order.',
      'Tasks:',
      '  - Write the model [done] — done means: it installs',
      '  - Write the view [running] — done means: it shows',
      'Findings: the view did not load',
    ].join('\n')
    expect(outlineMarkdown(story)).toBe([
      'Story "Module installs", in the feature "The field" of tree "Shop".',
      '',
      '**State:** failed, landed (merged).',
      '',
      '**Brief:** Add delivery_instructions to sale.order.',
      '',
      '**Tasks**',
      '',
      '  - Write the model [done] — done means: it installs',
      '  - Write the view [running] — done means: it shows',
      '',
      '**Findings:** the view did not load',
    ].join('\n'))
  })

  it('keeps a tree\'s branches nested over their leaves', () => {
    expect(outlineMarkdown('Goal: notes\n\nBranches and their leaves:\n- The field\n  - Module installs (l1) [failed, 0/1 tasks done]')).toBe(
      '**Goal:** notes\n\n**Branches and their leaves**\n\n- The field\n  - Module installs [failed, 0/1 tasks done]',
    )
  })

  it('names what a conversation is about by the most specific thing it is given', () => {
    expect(subjectOf({ treeId: 't', leafId: 'l', story: 's' })).toBe('story')
    expect(subjectOf({ treeId: 't', tree: 'x' })).toBe('tree')
    expect(subjectOf({ projectId: 'p', project: 'x' })).toBe('project')
    expect(subjectOf({})).toBe('conversation')
  })
})
