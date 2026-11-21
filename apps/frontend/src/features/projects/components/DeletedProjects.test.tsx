import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeletedProjects } from './DeletedProjects'
import * as projectsApi from '../api/projects'
import { useDeletionsStore } from '../stores/deletions'

vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listDeletedProjects: vi.fn(),
  restoreProject: vi.fn(),
  purgeProject: vi.fn(),
}))

const SHOP = { id: 'p1', name: 'shop', deletedAt: '2026-11-21T10:00:00.000Z', keptUntil: '2027-02-19T10:00:00.000Z' }

const renderDeleted = (onOpenProject = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><DeletedProjects onOpenProject={onOpenProject} /></QueryClientProvider>)
  return onOpenProject
}

describe('Deleted projects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDeletionsStore.setState({ followed: [], restored: {} })
    vi.mocked(projectsApi.listDeletedProjects).mockResolvedValue([SHOP])
  })

  it('lists each with its name, when it was deleted and the date it goes for good', async () => {
    renderDeleted()
    const row = await screen.findByRole('listitem', { name: 'shop' })
    expect(row).toHaveTextContent('Deleted on 21 November 2026')
    expect(row).toHaveTextContent('Deleted for good on 19 February 2027')
  })

  it('shows nothing when no project is kept', async () => {
    vi.mocked(projectsApi.listDeletedProjects).mockResolvedValue([])
    renderDeleted()
    await waitFor(() => expect(projectsApi.listDeletedProjects).toHaveBeenCalled())
    expect(screen.queryByText('Deleted projects')).not.toBeInTheDocument()
  })

  it('restores one and opens it, keeping what did not come back to tell its page', async () => {
    vi.mocked(projectsApi.restoreProject).mockResolvedValue({ name: 'shop (restored)', renamed: true, secrets: ['STRIPE_KEY'] })
    const onOpenProject = renderDeleted()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith('p1'))
    expect(useDeletionsStore.getState().restored).toEqual({ p1: { name: 'shop (restored)', renamed: true, secrets: ['STRIPE_KEY'] } })
  })

  it('deletes one for good now only once its name is typed, and follows that deletion to its end', async () => {
    vi.mocked(projectsApi.purgeProject).mockResolvedValue(undefined)
    renderDeleted()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently now' }))
    const confirm = screen.getByRole('button', { name: 'Delete shop for good' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(projectsApi.purgeProject).toHaveBeenCalledWith('p1', 'shop'))
    expect(useDeletionsStore.getState().followed).toEqual([{ projectId: 'p1', name: 'shop', mode: 'permanent' }])
  })

  it('says why a restore was refused', async () => {
    vi.mocked(projectsApi.restoreProject).mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { error: 'Only a deleted project kept for its 90 days can be restored' } } })
    const onOpenProject = renderDeleted()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('Only a deleted project kept for its 90 days can be restored')).toBeInTheDocument()
    expect(onOpenProject).not.toHaveBeenCalled()
  })
})
