import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RemoveAccountPage from './RemoveAccountPage'
import * as accountApi from '../../api/account'

vi.mock('../../api/account', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  getRemovalPreview: vi.fn(),
  removeMyAccount: vi.fn(),
}))

const renderPage = (onRemoved = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RemoveAccountPage onRemoved={onRemoved} /></QueryClientProvider>)
  return onRemoved
}

describe('deleting your account on root', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says a pool instance is deleted with it, and removes only once the email is typed', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [], instance: { name: 'bo', where: 'pool', status: 'ready', url: 'https://bo.koala.dev' } })
    vi.mocked(accountApi.removeMyAccount).mockResolvedValue({ state: 'running', done: [] })
    const onRemoved = renderPage()

    expect(await screen.findByText(/Your instance bo on Koala's servers is deleted, with everything in it/)).toBeInTheDocument()
    const remove = screen.getByRole('button', { name: 'Delete my account' })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bo@example.com' } })
    fireEvent.click(remove)
    expect(await screen.findByText(/signed out everywhere/)).toBeInTheDocument()
    expect(accountApi.removeMyAccount).toHaveBeenCalledWith('bo@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onRemoved).toHaveBeenCalled()
  })

  it('says an instance on your own machine keeps running there until you uninstall it', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [], instance: { name: 'bo', where: 'own', status: 'ready', url: 'https://bo.koala.dev' } })
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
