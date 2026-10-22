import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StoryDrops } from './StoryDrops'

describe('the code dropped on a story', () => {
  it('lists the newest first with where each stands', () => {
    render(<StoryDrops drops={[
      { id: 'a', branch: 'drop/l1/a', paths: ['logo.svg'], at: '2026-10-21T10:00:00Z', by: 'u1', state: 'merged' },
      { id: 'b', branch: 'drop/l1/b', paths: ['a.ts', 'b.ts'], at: '2026-10-21T11:00:00Z', by: 'u1', state: 'conflict', conflicts: ['a.ts'] },
    ]} />)
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('2 files not merged: it conflicts with the story\'s own changes (a.ts)')
    expect(items[1]).toHaveTextContent('logo.svg merged into its checkout')
  })
})
