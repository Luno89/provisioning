import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ChatNotice } from './ChatNotice'

vi.mock('../../../releases/components/OpenApp.js', () => ({ OpenApp: () => null }))

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

describe('a notice that a build waits for the client\'s database', () => {
  it('shows, and opens the project\'s Settings', () => {
    render(<ChatNotice notice={{ key: 'held:p1', kind: 'client-database-awaited', text: 'Shop is built and waits for the client\'s database.', refs: { projectId: 'p1' }, actions: ['open-settings'] }} />)
    expect(screen.getByText('Shop is built and waits for the client\'s database.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(window.location.hash).toBe('#/projects/project/p1/settings')
  })
})

describe('a notice about an alert', () => {
  it('opens the app\'s health when it fires', () => {
    render(<ChatNotice notice={{ key: 'alert:e1:fired', kind: 'alert-firing', text: 'Alert: Books is not answering.', refs: { clusterId: 'c1', deploymentId: 'books' }, actions: ['open-monitoring'] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open its health' }))
    expect(window.location.hash).toBe('#/infrastructure/app/books')
  })

  it('opens the cluster\'s health for a machine alert, and shows when one resolves', () => {
    render(<ChatNotice notice={{ key: 'alert:e2:resolved', kind: 'alert-resolved', text: 'Resolved: The disk is filling up.', refs: { clusterId: 'c1' }, actions: ['open-monitoring'] }} />)
    expect(screen.getByText('Resolved: The disk is filling up.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open its health' }))
    expect(window.location.hash).toBe('#/infrastructure/cluster/c1')
  })
})
