import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeleteAccount } from './DeleteAccount'
import * as accountApi from '../../api/account'
import * as authApi from '../../features/platform/api'
import { useShellStore } from '../../features/platform/stores/shell'

vi.mock('../../api/account', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  getRemovalPreview: vi.fn(),
  removeMyAccount: vi.fn(),
}))

vi.mock('../../features/platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof authApi>()),
  accountRemovalPlace: vi.fn(),
}))

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><DeleteAccount /></QueryClientProvider>)
}

describe('deleting your own account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com' } as never)
  })

  it('removes the account only once the email is typed, then signs out', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [] })
    vi.mocked(accountApi.removeMyAccount).mockResolvedValue({ state: 'running', done: [] })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }))
    const confirm = await screen.findByRole('textbox')
    const remove = screen.getByRole('button', { name: 'Delete my account' })
    fireEvent.change(confirm, { target: { value: 'bo' } })
    expect(remove).toBeDisabled()

    fireEvent.change(confirm, { target: { value: 'BO@example.com' } })
    fireEvent.click(remove)
    await waitFor(() => expect(useShellStore.getState().user).toBeNull())
    expect(accountApi.removeMyAccount).toHaveBeenCalledWith('BO@example.com')
  })

  it('shows what still stands in the way instead of the confirmation', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: ['the app "odoo" is still deployed; remove it first'] })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }))
    expect(await screen.findByText('the app "odoo" is still deployed; remove it first')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull()
  })
})

describe('deleting your account from inside an instance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', holdsAccounts: false } as never)
  })

  it('removes nothing here and sends you to Koala, where the account is kept', async () => {
    vi.mocked(authApi.accountRemovalPlace).mockResolvedValue('https://koala.dev/#/remove-account')
    renderSection()

    const link = await screen.findByRole('link', { name: 'Delete my account on Koala…' })
    expect(link).toHaveAttribute('href', 'https://koala.dev/#/remove-account')
    expect(screen.queryByRole('button', { name: 'Delete account…' })).toBeNull()
    expect(accountApi.getRemovalPreview).not.toHaveBeenCalled()
  })
})

