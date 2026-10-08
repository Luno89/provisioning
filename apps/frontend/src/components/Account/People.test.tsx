import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { People } from './People'
import * as accountApi from '../../api/account'

vi.mock('../../api/account', async (importOriginal) => ({
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
      { id: 'ana', email: 'ana@example.com', isAdmin: true, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'bo', email: 'bo@example.com', isAdmin: false, createdAt: '2026-10-01T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'running', done: ['workflows'] } } },
      { id: 'cy', email: 'cy@example.com', isAdmin: false, createdAt: '2026-10-01T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'failed', reason: 'Gitea would not delete the user' } } },
    ])
    renderSection()

    expect(await screen.findByText('deleting its workspaces (2 of 6)')).toBeInTheDocument()
    expect(screen.getByText('Stopped: Gitea would not delete the user')).toBeInTheDocument()
    vi.mocked(accountApi.removePerson).mockResolvedValue({ state: 'running', done: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(accountApi.removePerson).toHaveBeenCalledWith('cy', 'cy@example.com'))
  })

  it('removes someone once their email is typed', async () => {
    vi.mocked(accountApi.listPeople).mockResolvedValue([{ id: 'bo', email: 'bo@example.com', isAdmin: false, createdAt: '2026-10-01T00:00:00.000Z' }])
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
})
