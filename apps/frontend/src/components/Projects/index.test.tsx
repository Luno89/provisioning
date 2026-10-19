import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Projects } from './index.js'
import * as groveApi from '../../api/grove.js'

vi.mock('../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listBranches: vi.fn().mockResolvedValue([]),
}))

vi.mock('./ProjectList.js', () => ({
  ProjectList: ({ onOpenTree, onOpenProject }: { onOpenTree: (id: string) => void; onOpenProject: (id: string) => void }) => (
    <div data-testid="project-list">
      <button onClick={() => onOpenTree('tree-1')}>open-tree-1</button>
      <button onClick={() => onOpenProject('proj-1')}>open-proj-1</button>
    </div>
  ),
}))

vi.mock('./Files/index.js', () => ({
  default: ({ treeId, projectId }: { treeId?: string; projectId?: string }) => (
    <div data-testid="workspace">
      Files for {treeId ? `tree:${treeId}` : `project:${projectId}`}
    </div>
  ),
}))

vi.mock('./Releases/index.js', () => ({
  default: ({ treeId, projectId }: { treeId?: string; projectId?: string }) => (
    <div data-testid="releases">Releases for {treeId ? `tree:${treeId}` : `project:${projectId}`}</div>
  ),
}))

vi.mock('./Strip/ProjectStrip.js', () => ({
  default: ({ treeId, projectId, channel }: { treeId?: string; projectId?: string; channel?: { open: boolean; onToggle: () => void } }) => (
    <div data-testid="strip">
      Strip for {treeId ? `tree:${treeId}` : `project:${projectId}`}
      {channel && <button type="button" onClick={channel.onToggle}>{channel.open ? 'Hide the channel' : 'Channel'}</button>}
    </div>
  ),
}))

vi.mock('./Settings/index.js', () => ({
  default: ({ treeId, projectId }: { treeId?: string; projectId?: string }) => (
    <div data-testid="settings">Settings for {treeId ? `tree:${treeId}` : `project:${projectId}`}</div>
  ),
}))

vi.mock('./Board/index.js', () => ({
  default: ({ treeId, projectId, initialBranchId, initialLeafId, chatOpen }: { treeId?: string; projectId?: string; initialBranchId?: string; initialLeafId?: string; chatOpen?: boolean }) => (
    <div data-testid="board">
      Board for {treeId ? `tree:${treeId}` : `project:${projectId}`}{initialBranchId ? ` in ${initialBranchId}` : ''}{initialLeafId ? ` at ${initialLeafId}` : ''}{chatOpen === false ? ' without its chat' : ''}
    </div>
  ),
}))

afterEach(() => {
  window.location.hash = ''
})

function renderProjects() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Projects clusters={[]} />
    </QueryClientProvider>,
  )
}

describe('Projects component routing and hash synchronization', () => {
  it('renders ProjectList when there is no hash or hash is #/projects', () => {
    window.location.hash = '#/projects'
    renderProjects()
    expect(screen.getByTestId('project-list')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()
  })

  it('opens a tree on its board, and its files under /files', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()
    expect(await screen.findByText('Board for tree:tree-1')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(window.location.hash).toBe('#/projects/tree/tree-1/files')
    expect(await screen.findByText('Files for tree:tree-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Board' }))
    expect(window.location.hash).toBe('#/projects/tree/tree-1')
    expect(await screen.findByText('Board for tree:tree-1')).toBeInTheDocument()
  })

  it('shows what is going on across every tab, opens releases under /releases, and remembers the chat panel closed', async () => {
    localStorage.removeItem('project-chat-closed')
    window.location.hash = '#/projects/tree/tree-1'
    const { unmount } = renderProjects()
    expect(await screen.findByText('Strip for tree:tree-1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide the channel' }))
    expect(await screen.findByText('Board for tree:tree-1 without its chat')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Releases' }))
    expect(window.location.hash).toBe('#/projects/tree/tree-1/releases')
    expect(await screen.findByText('Releases for tree:tree-1')).toBeInTheDocument()
    expect(screen.getByText('Strip for tree:tree-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /channel/i })).toBeNull()
    unmount()

    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()
    expect(await screen.findByText('Board for tree:tree-1 without its chat')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Channel' }))
    expect(await screen.findByText('Board for tree:tree-1')).toBeInTheDocument()
  })

  it('opens a tree\'s settings under /settings, and a project\'s straight from its address', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    const { unmount } = renderProjects()
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }))
    expect(window.location.hash).toBe('#/projects/tree/tree-1/settings')
    expect(await screen.findByText('Settings for tree:tree-1')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    unmount()
    window.location.hash = '#/projects/project/p1/settings'
    renderProjects()
    expect(await screen.findByText('Settings for project:p1')).toBeInTheDocument()
  })

  it('opens a project\'s files straight from its address, and a story on the board from a link to it', async () => {
    window.location.hash = '#/projects/project/p1/files'
    const { unmount } = renderProjects()
    expect(await screen.findByText('Files for project:p1')).toBeInTheDocument()
    unmount()
    window.location.hash = '#/projects/tree/tree-1/branch-1/leaf-1'
    renderProjects()
    expect(await screen.findByText('Board for tree:tree-1 in branch-1 at leaf-1')).toBeInTheDocument()
  })

  it('opens a feature on the board from a link to it', async () => {
    window.location.hash = '#/projects/tree/tree-1/branch-1'
    renderProjects()
    expect(await screen.findByText('Board for tree:tree-1 in branch-1')).toBeInTheDocument()
  })

  it('refreshes the workspace when the hash changes to another tree via hashchange event', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()

    expect(await screen.findByText('Board for tree:tree-1')).toBeInTheDocument()

    act(() => {
      window.location.hash = '#/projects/tree/tree-2'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByText('Board for tree:tree-2')).toBeInTheDocument()
    expect(screen.queryByText('Board for tree:tree-1')).not.toBeInTheDocument()
  })

  it('returns to ProjectList when Back to Projects is clicked', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()

    expect(await screen.findByText('Board for tree:tree-1')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Back to Projects'))

    expect(window.location.hash).toBe('#/projects')
    expect(await screen.findByTestId('project-list')).toBeInTheDocument()
  })

  it('navigates to workspace when ProjectList triggers openTree', async () => {
    window.location.hash = '#/projects'
    renderProjects()

    expect(screen.getByTestId('project-list')).toBeInTheDocument()
    fireEvent.click(screen.getByText('open-tree-1'))

    expect(window.location.hash).toBe('#/projects/tree/tree-1')
    expect(await screen.findByText('Board for tree:tree-1')).toBeInTheDocument()
  })
})
