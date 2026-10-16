import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ChatNotice } from './ChatNotice'

vi.mock('../Projects/Workspace/OpenApp.js', () => ({ OpenApp: () => null }))

describe('a notice about one story, in the channel', () => {
  it('leads to the story', () => {
    const onOpenStory = vi.fn()
    render(<ChatNotice
      notice={{ key: 'leaf:l2:failed:r:line', kind: 'leaf-failed', text: 'The story "The proof" failed; what went wrong is in its chat.', refs: { treeId: 't1', branchId: 'b2', leafId: 'l2' }, actions: ['open-story'] }}
      onOpenStory={onOpenStory}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the story' }))
    expect(onOpenStory).toHaveBeenCalledWith({ treeId: 't1', branchId: 'b2', leafId: 'l2' })
  })
})

describe('a notice about the tree\'s workspace', () => {
  it('opens the tree\'s Files page, where its Workspace section is', () => {
    render(<ChatNotice notice={{ key: 'workspace:r1:failed', kind: 'workspace-failed', text: 'The workspace for Shop could not be built.', refs: { treeId: 't1' }, actions: ['open-workspace'] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the workspace' }))
    expect(window.location.hash).toBe('#/projects/tree/t1/files')
  })
})

describe('a notice about a client\'s database', () => {
  it('opens the project\'s Settings, under its tree when it has one', () => {
    render(<ChatNotice notice={{ key: 'release:r1:failed', kind: 'release-failed', text: 'Starting from the client\'s database failed.', refs: { projectId: 'p1' }, actions: ['open-settings'] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(window.location.hash).toBe('#/projects/project/p1/settings')
  })
})
