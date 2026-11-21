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

  it('shows a removal waiting on the person\'s own Koala, each thing it is stopping and deleting as it really stands, and the machine it waits for while that is off', async () => {
    const koala = {
      seq: 7,
      phase: 'deleting' as const,
      work: [{ workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: 'then', state: 'stopped' as const, what: 'Tree run: Shop', killed: ['terraform'] }],
      parts: { projects: { state: 'deleted' as const, left: 0, deleted: 2 }, apps: { state: 'deleting' as const, left: 1, deleted: 1 } },
    }
    vi.mocked(accountApi.listPeople).mockResolvedValue([
      { id: 'bo', email: 'bo@example.com', operator: false, createdAt: '2026-10-01T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'running', done: ['instance'] }, steps: ['instance', 'koala', 'mesh', 'records'], koala, koalaAway: { machine: 'Desk', since: '2026-11-21T09:00:00.000Z' } } },
      { id: 'cy', email: 'cy@example.com', operator: false, createdAt: '2026-10-01T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'running', done: ['instance'] }, steps: ['instance', 'koala', 'mesh', 'records'], koala: { seq: 3, phase: 'deleting', work: [], parts: {}, problem: 'Gitea would not delete the user koala-cy (HTTP 403)' } } },
    ])
    renderSection()

    expect(await screen.findAllByText('their own Koala deleting everything of theirs (2 of 4)')).toHaveLength(2)
    expect(screen.getByText('Tree run: Shop: stopped')).toBeInTheDocument()
    expect(screen.getByText('terraform: killed')).toBeInTheDocument()
    expect(screen.getByText('Projects: 2 deleted for good')).toBeInTheDocument()
    expect(screen.getByText('Apps: 1 left, 1 removed')).toBeInTheDocument()
    expect(screen.getByText('Waiting for Desk to be back, off since 21 November 2026, 09:00 UTC. The removal goes on when it is.')).toBeInTheDocument()
    expect(screen.getByText('Not removed yet: Gitea would not delete the user koala-cy (HTTP 403)')).toBeInTheDocument()
    vi.mocked(accountApi.removePerson).mockResolvedValue({ state: 'running', done: ['instance'] })
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
