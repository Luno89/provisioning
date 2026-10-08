import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectDeletePanel } from './ProjectDeletePanel'
import * as projectsApi from '../../../api/projects'

vi.mock('../../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  getProjectRemoval: vi.fn(),
  deleteProject: vi.fn(),
}))

const PREVIEW = {
  name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 2, conversations: 1 }], keptConversations: 1, builds: 0, blockers: [], state: { state: 'none' as const },
}

const renderPanel = (onDeleted = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectDeletePanel projectId="p1" onDeleted={onDeleted} /></QueryClientProvider>)
  return onDeleted
}

describe('deleting a project from its page', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows what goes with it in a popup, deletes once the name is typed, follows it through, and closes the page when it is gone', async () => {
    vi.mocked(projectsApi.getProjectRemoval).mockResolvedValueOnce(PREVIEW)
    vi.mocked(projectsApi.deleteProject).mockResolvedValue({ state: 'running', done: [] })
    const onDeleted = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /Delete this project/ }))
    expect(await screen.findByText('The tree “Shop features”, with 2 leaves, their tasks and plans, 1 conversation and its sandbox')).toBeInTheDocument()
    expect(screen.getByText('One conversation about the project is kept, no longer linked to it.')).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Delete project' })
    expect(confirm).toBeDisabled()

    vi.mocked(projectsApi.getProjectRemoval).mockResolvedValueOnce({ ...PREVIEW, state: { state: 'running', done: ['workflows'] } })
    vi.mocked(projectsApi.getProjectRemoval).mockRejectedValue({ response: { status: 404 } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(projectsApi.deleteProject).toHaveBeenCalledWith('p1', 'shop'))

    fireEvent.click(await screen.findByRole('button', { name: 'Done' }, { timeout: 8_000 }))
    expect(onDeleted).toHaveBeenCalled()
  }, 15_000)

  it('names what stands in the way instead of offering to delete', async () => {
    vi.mocked(projectsApi.getProjectRemoval).mockResolvedValue({ ...PREVIEW, blockers: ['the app "shop-web" built from it is still deployed; remove it first'] })
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /Delete this project/ }))
    expect(await screen.findByText('the app "shop-web" built from it is still deployed; remove it first')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull()
  })
})
