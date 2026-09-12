import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'
import { ProjectList } from './ProjectList.js'
import * as groveApi from '../../api/grove.js'
import * as projectsApi from '../../api/projects.js'

vi.mock('../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn(),
}))
vi.mock('../../api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listProjects: vi.fn(),
}))

function renderList(handlers: Partial<Parameters<typeof ProjectList>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ProjectList
        onOpenTree={vi.fn()}
        onOpenProject={vi.fn()}
        onNewTree={vi.fn()}
        onNewProject={vi.fn()}
        {...handlers}
      />
    </QueryClientProvider>,
  )
}

describe('ProjectList', () => {
  it('renders a merged card for a tree with a linked project', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([{ id: 't1', name: 'widget', branchCount: 1, projectIds: ['p1'] } as never])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{ id: 'p1', name: 'widget', giteaOwner: 'acme', giteaRepo: 'widget' }])

    renderList()

    expect(await screen.findByText('widget')).toBeInTheDocument()
    expect(screen.getByText('acme/widget')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /widget/ })).toHaveLength(1)
  })

  it('opens the tree workspace when a tree-backed card is clicked', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([{ id: 't1', name: 'widget', branchCount: 0, projectIds: [] } as never])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([])
    const onOpenTree = vi.fn()

    renderList({ onOpenTree })
    fireEvent.click(await screen.findByText('widget'))

    expect(onOpenTree).toHaveBeenCalledWith('t1')
  })

  it('opens the project workspace when a project-only card is clicked', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{ id: 'p1', name: 'standalone', giteaOwner: 'acme', giteaRepo: 'standalone' }])
    const onOpenProject = vi.fn()

    renderList({ onOpenProject })
    fireEvent.click(await screen.findByText('standalone'))

    expect(onOpenProject).toHaveBeenCalledWith('p1')
  })

  it('shows an empty state with nothing to click when there are no trees or projects', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([])

    renderList()

    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
  })

  it('calls onNewTree / onNewProject from the header buttons', () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([])
    const onNewTree = vi.fn()
    const onNewProject = vi.fn()

    renderList({ onNewTree, onNewProject })
    fireEvent.click(screen.getByText('New Tree'))
    fireEvent.click(screen.getByText('New Project'))

    expect(onNewTree).toHaveBeenCalled()
    expect(onNewProject).toHaveBeenCalled()
  })
})
