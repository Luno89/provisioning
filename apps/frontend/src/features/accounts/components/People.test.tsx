import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { People } from './People'
import * as accountApi from '../api'
import { refused } from '../../../test/refused'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  listPeople: vi.fn(),
  getPersonRemoval: vi.fn(),
  removePerson: vi.fn(),
}))

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><People /></QueryClientProvider>)
}

describe('the people an admin can remove', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists everyone, with how a removal under way or stopped is going', async () => {
    vi.mocked(accountApi.listPeople).mockResolvedValue([
      { id: 'ana', email: 'ana@example.com', operator: true, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'bo', email: 'bo@example.com', operator: false, createdAt: '2026-10-01T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'running', done: ['workflows', 'projects', 'repositories', 'apps'] } } },
      { id: 'cy', email: 'cy@example.com', operator: false, createdAt: '2026-10-01T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'failed', reason: 'Gitea would not delete the user' } } },
    ])
    renderSection()

    expect(await screen.findByText('deleting its workspaces (5 of 8)')).toBeInTheDocument()
    expect(screen.getByText('Stopped: Gitea would not delete the user')).toBeInTheDocument()
    vi.mocked(accountApi.removePerson).mockResolvedValue({ state: 'running', done: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(accountApi.removePerson).toHaveBeenCalledWith('cy', 'cy@example.com'))
  })

  it('removes someone once their email is typed', async () => {
    vi.mocked(accountApi.listPeople).mockResolvedValue([{ id: 'bo', email: 'bo@example.com', operator: false, createdAt: '2026-10-01T00:00:00.000Z' }])
    vi.mocked(accountApi.getPersonRemoval).mockResolvedValue({ email: 'bo@example.com', blockers: [] })
    vi.mocked(accountApi.removePerson).mockResolvedValue({ state: 'running', done: [] })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove…' }))
    const remove = await screen.findByRole('button', { name: 'Remove account' })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bo@example.com' } })
    fireEvent.click(remove)
    await waitFor(() => expect(accountApi.removePerson).toHaveBeenCalledWith('bo', 'bo@example.com'))
  })

  it('says why the removal was refused, keeping the confirmation open', async () => {
    vi.mocked(accountApi.listPeople).mockResolvedValue([{ id: 'bo', email: 'bo@example.com', operator: false, createdAt: '2026-10-01T00:00:00.000Z' }])
    vi.mocked(accountApi.getPersonRemoval).mockResolvedValue({ email: 'bo@example.com', blockers: [] })
    vi.mocked(accountApi.removePerson).mockRejectedValue(refused(409, { error: 'This account is being removed' }))
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove…' }))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'bo@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    expect(await screen.findByText('This account is being removed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove account' })).toBeInTheDocument()
  })

  it('says why the people could not be listed', async () => {
    vi.mocked(accountApi.listPeople).mockRejectedValue(refused(403, { error: 'Admin only' }))
    renderSection()

    expect(await screen.findByText('Admin only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove…' })).toBeNull()
  })
})
