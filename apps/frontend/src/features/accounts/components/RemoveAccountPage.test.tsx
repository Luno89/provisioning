import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RemoveAccountPage from './RemoveAccountPage'
import * as accountApi from '../api'
import { useShellStore } from '../../platform/stores/shell'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  getRemovalPreview: vi.fn(),
  removeMyAccount: vi.fn(),
  getMyRemovalProgress: vi.fn(),
}))

const STARTED = { state: { state: 'running' as const, done: [] }, progress: 'progress-of-bo' }

const renderPage = (onRemoved = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RemoveAccountPage onRemoved={onRemoved} /></QueryClientProvider>)
  return onRemoved
}

describe('deleting your account on root', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', confirmWith: 'password' } as never)
  })

  it('says what happens to the instance, and removes only once the email and the password are typed', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [], instance: { name: 'bo', status: 'ready', url: 'https://bo.koala.dev' } })
    vi.mocked(accountApi.removeMyAccount).mockResolvedValue(STARTED)
    vi.mocked(accountApi.getMyRemovalProgress).mockResolvedValue({ removal: { startedAt: 'then', requestedBy: 'bo', state: { state: 'running', done: [] } } })
    const onRemoved = renderPage()

    expect(await screen.findByText(/Your instance bo is let go of/)).toBeInTheDocument()
    const remove = screen.getByRole('button', { name: 'Delete my account' })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bo@example.com' } })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'my-own-password' } })
    fireEvent.click(remove)
    expect(await screen.findByText(/signed out everywhere/)).toBeInTheDocument()
    expect(accountApi.removeMyAccount).toHaveBeenCalledWith('bo@example.com', { password: 'my-own-password' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onRemoved).toHaveBeenCalled()
  })

  const removeOnThePage = async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [] })
    vi.mocked(accountApi.removeMyAccount).mockResolvedValue(STARTED)
    renderPage()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'bo@example.com' } })
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'my-own-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
  }

  it('follows the removal once you are signed out, as root\'s People list shows it, each thing in its real state', async () => {
    vi.mocked(accountApi.getMyRemovalProgress).mockResolvedValueOnce({
      removal: {
        startedAt: 'then',
        requestedBy: 'bo',
        state: { state: 'running', done: ['instance'] },
        steps: ['instance', 'koala', 'machines', 'mesh', 'records'],
        koala: { seq: 1, phase: 'deleting', work: [{ workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: 'then', state: 'stopping', what: 'An agent at work' }], parts: {} },
        machinesAway: [{ machine: 'Desk', since: '2026-11-21T09:00:00.000Z' }],
      },
    })
    await removeOnThePage()
    expect(await screen.findByText('their own Koala deleting everything of theirs (2 of 5)')).toBeInTheDocument()
    expect(screen.getByText('An agent at work: stopping')).toBeInTheDocument()
    expect(screen.getByText(/Waiting for Desk to be back, off since/)).toBeInTheDocument()
    expect(accountApi.getMyRemovalProgress).toHaveBeenCalledWith('progress-of-bo')
  })

  it('says the account is removed once the removal has finished', async () => {
    vi.mocked(accountApi.getMyRemovalProgress).mockResolvedValue({ removed: true })
    await removeOnThePage()
    expect(await screen.findByText('Your account is removed.')).toBeInTheDocument()
  })

  it('says an instance on your own machine keeps running there until you uninstall it', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [], instance: { name: 'bo', status: 'ready', url: 'https://bo.koala.dev' } })
    renderPage()

    expect(await screen.findByText(/nobody can sign in to it any more/)).toBeInTheDocument()
    expect(screen.getByText(/keeps running on your own machine/)).toBeInTheDocument()
  })

  it('shows what stands in the way instead of the confirmation', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: ['this is the only admin account; make someone else an admin first'] })
    renderPage()

    expect(await screen.findByText(/only admin account/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull()
  })
})
