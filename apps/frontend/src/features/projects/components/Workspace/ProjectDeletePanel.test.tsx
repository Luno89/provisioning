import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectDeletePanel } from './ProjectDeletePanel'
import * as projectsApi from '../../api/projects'
import { useDeletionsStore } from '../../stores/deletions'

vi.mock('../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  getProjectRemoval: vi.fn(),
  deleteProject: vi.fn(),
}))

const PREVIEW = {
  name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 2, conversations: 1 }], keptConversations: 1, builds: 0, apps: ['shop-web'],
}
const DELETION = { startedAt: '2026-11-21T10:00:00.000Z', requestedBy: 'bo', mode: 'archive' as const, phase: 'deleting' as const }

const renderPanel = (onDeleted = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectDeletePanel projectId="p1" onDeleted={onDeleted} /></QueryClientProvider>)
  return { onDeleted, client }
}

const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Delete this project/ }))
  await screen.findByText('Deleted now:')
}

const pressDelete = async () => {
  const { onDeleted } = renderPanel()
  await open()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop' } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
  return onDeleted
}

describe('deleting a project from its page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDeletionsStore.setState({ followed: [] })
    vi.mocked(projectsApi.getProjectRemoval).mockResolvedValue(PREVIEW)
  })

  it('says what goes now and what is kept until the date it names, and offers both ways to delete once the name is typed', async () => {
    renderPanel()
    await open()
    expect(screen.getByText('The app “shop-web” running on its cluster, with its databases and files')).toBeInTheDocument()
    expect(screen.getByText(/^Kept for 90 days, until \d+ \w+ \d{4}, then deleted for good:$/)).toBeInTheDocument()
    expect(screen.getByText('Its code: the repository koala-bo/shop, with its history')).toBeInTheDocument()
    expect(screen.getByText('You can restore it from Deleted projects until then.')).toBeInTheDocument()
    expect(screen.getByText('One conversation about the project is kept, no longer linked to it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete permanently now' })).toBeDisabled()
  })

  it('keeps it for 90 days when "Delete project" is pressed, follows its deletion outside the page, and closes the page', async () => {
    vi.mocked(projectsApi.deleteProject).mockResolvedValue(DELETION)
    const onDeleted = await pressDelete()
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(projectsApi.deleteProject).toHaveBeenCalledWith('p1', 'shop', 'archive')
    expect(useDeletionsStore.getState().followed).toEqual([{ projectId: 'p1', name: 'shop', mode: 'archive' }])
  })

  it('lists everything as deleted now before "Delete permanently now", and deletes it for good', async () => {
    vi.mocked(projectsApi.deleteProject).mockResolvedValue({ ...DELETION, mode: 'permanent' })
    const { onDeleted } = renderPanel()
    await open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently now' }))
    expect(screen.queryByText(/^Kept for 90 days/)).not.toBeInTheDocument()
    expect(screen.getByText('Nothing is kept, and it cannot be restored.')).toBeInTheDocument()
    expect(screen.getByText('Its code: the repository koala-bo/shop, with its history')).toBeInTheDocument()
    expect(projectsApi.deleteProject, 'the first press shows what goes, it deletes nothing').not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it for 90 days instead' }))
    expect(screen.getByText(/^Kept for 90 days/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently now' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(projectsApi.deleteProject).toHaveBeenCalledWith('p1', 'shop', 'permanent')
    expect(useDeletionsStore.getState().followed).toEqual([{ projectId: 'p1', name: 'shop', mode: 'permanent' }])
  })

  it('says why it was refused, and keeps the page open', async () => {
    vi.mocked(projectsApi.deleteProject).mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { error: 'Type the project\'s name, shop, to confirm' } } })
    const onDeleted = await pressDelete()
    expect(await screen.findByText('Type the project\'s name, shop, to confirm')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(useDeletionsStore.getState().followed).toEqual([])
  })
})
