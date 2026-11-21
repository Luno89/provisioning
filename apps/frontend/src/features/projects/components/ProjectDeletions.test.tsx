import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectDeletions } from './ProjectDeletions'
import * as projectsApi from '../api/projects'
import { useDeletionsStore } from '../stores/deletions'
import { PROJECT_DELETION, type DeletionProgress } from '../types/project-removal'
import { socketHandlers as handlers } from '../../../test/socket-events'

vi.mock('../../platform/stores/socket', () => import('../../../test/socket-events'))
vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  getProjectRemoval: vi.fn(),
  deleteProject: vi.fn(),
}))

const at = '2026-11-21T10:00:00.000Z'
const PREVIEW = { name: 'shop', trees: [], keptConversations: 0, builds: 0, apps: [] }
const progress = (seq: number, over: Partial<DeletionProgress> = {}): DeletionProgress => ({ seq, phase: 'deleting', work: [], parts: {}, ...over })
const tell = (event: { projectId: string; progress: DeletionProgress }) => act(async () => { handlers.get(PROJECT_DELETION)!(event) })

const renderDeletions = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidated = vi.spyOn(client, 'invalidateQueries')
  render(<QueryClientProvider client={client}><ProjectDeletions /></QueryClientProvider>)
  return { invalidated }
}

describe('a project\'s deletion, followed after its page has closed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDeletionsStore.setState({ followed: [{ projectId: 'p1', name: 'shop', mode: 'archive' }] })
    vi.mocked(projectsApi.getProjectRemoval).mockResolvedValue({ ...PREVIEW, deletion: { startedAt: at, requestedBy: 'bo', mode: 'archive', phase: 'deleting' } })
  })

  it('says Deleting at once, then each running thing as it really stops and the counts going down, as the server tells it', async () => {
    renderDeletions()
    expect(await screen.findByText('Deleting')).toBeInTheDocument()
    await tell({ projectId: 'p1', progress: progress(1, { work: [{ workflowId: 'r', type: 'AgentRunWorkflow', startedAt: at, state: 'stopping', what: 'Tree run: Grow the tree' }] }) })
    expect(await screen.findByText('Tree run: Grow the tree: stopping')).toBeInTheDocument()
    await tell({ projectId: 'p1', progress: progress(3, { work: [{ workflowId: 'r', type: 'AgentRunWorkflow', startedAt: at, state: 'stopped', what: 'Tree run: Grow the tree' }], parts: { apps: { state: 'deleting', left: 1, deleted: 1 } } }) })
    expect(await screen.findByText('Apps: 1 left, 1 removed')).toBeInTheDocument()
    await tell({ projectId: 'p1', progress: progress(2, { work: [{ workflowId: 'r', type: 'AgentRunWorkflow', startedAt: at, state: 'stopping', what: 'Tree run: Grow the tree' }] }) })
    expect(await screen.findByText('Tree run: Grow the tree: stopped')).toBeInTheDocument()
    expect(screen.getByText('Apps: 1 left, 1 removed')).toBeInTheDocument()
    expect(projectsApi.getProjectRemoval).toHaveBeenCalledTimes(1)
  })

  it('ends "Deleted — kept until <date>", refreshes the lists, and goes when dismissed', async () => {
    const { invalidated } = renderDeletions()
    await screen.findByText('Deleting')
    await tell({ projectId: 'p1', progress: progress(4, { phase: 'archived', keptUntil: '2027-02-19T10:00:00.000Z' }) })
    expect(await screen.findByText('Deleted — kept until 19 February 2027')).toBeInTheDocument()
    expect(screen.getByText('You can restore it from Deleted projects until then.')).toBeInTheDocument()
    expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(expect.arrayContaining([projectsApi.projectKeys.list(), projectsApi.projectKeys.deleted()]))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(useDeletionsStore.getState().followed).toEqual([])
  })

  it('ends "Deleted for good", also when the server says it is gone before the browser heard the end', async () => {
    useDeletionsStore.setState({ followed: [{ projectId: 'p1', name: 'shop', mode: 'permanent' }, { projectId: 'p2', name: 'blog', mode: 'permanent' }] })
    vi.mocked(projectsApi.getProjectRemoval).mockImplementation(async (id) => {
      if (id === 'p2') throw Object.assign(new Error('Project not found'), { isAxiosError: true, response: { status: 404, data: { error: 'Project not found' } } })
      return { ...PREVIEW, deletion: { startedAt: at, requestedBy: 'bo', mode: 'permanent', phase: 'deleting' } }
    })
    renderDeletions()
    await screen.findByText('Deleting')
    await tell({ projectId: 'p1', progress: progress(9, { phase: 'deleted' }) })
    await waitFor(() => expect(screen.getAllByText('Deleted for good')).toHaveLength(2))
  })

  it('shows why it cannot be deleted yet and tries again, never saying Deleted', async () => {
    vi.mocked(projectsApi.deleteProject).mockResolvedValue({ startedAt: at, requestedBy: 'bo', mode: 'archive', phase: 'deleting' })
    renderDeletions()
    await screen.findByText('Deleting')
    await tell({ projectId: 'p1', progress: progress(5, { problem: 'Gitea refused to delete koala-bo/shop: 403', parts: { repositories: { state: 'deleting', deleted: 0 } } }) })
    expect(await screen.findByText('Not deleted yet: Gitea refused to delete koala-bo/shop: 403')).toBeInTheDocument()
    expect(screen.queryByText(/^Deleted/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(projectsApi.deleteProject).toHaveBeenCalledWith('p1', 'shop', 'archive'))
  })

  it('pays no attention to another project\'s deletion', async () => {
    renderDeletions()
    await screen.findByText('Deleting')
    await tell({ projectId: 'other', progress: progress(9, { phase: 'deleted' }) })
    expect(screen.queryByText('Deleted for good')).not.toBeInTheDocument()
  })
})
