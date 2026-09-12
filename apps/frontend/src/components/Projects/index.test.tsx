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

vi.mock('./Workspace/index.js', () => ({
  default: ({ treeId, projectId }: { treeId?: string; projectId?: string }) => (
    <div data-testid="workspace">
      Workspace for {treeId ? `tree:${treeId}` : `project:${projectId}`}
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

  it('renders Workspace when hash points to a tree', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()
    expect(await screen.findByText('Workspace for tree:tree-1')).toBeInTheDocument()
  })

  it('refreshes the workspace when the hash changes to another tree via hashchange event', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()

    expect(await screen.findByText('Workspace for tree:tree-1')).toBeInTheDocument()

    act(() => {
      window.location.hash = '#/projects/tree/tree-2'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByText('Workspace for tree:tree-2')).toBeInTheDocument()
    expect(screen.queryByText('Workspace for tree:tree-1')).not.toBeInTheDocument()
  })

  it('returns to ProjectList when Back to Projects is clicked', async () => {
    window.location.hash = '#/projects/tree/tree-1'
    renderProjects()

    expect(await screen.findByText('Workspace for tree:tree-1')).toBeInTheDocument()

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
    expect(await screen.findByText('Workspace for tree:tree-1')).toBeInTheDocument()
  })
})
