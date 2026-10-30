import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeleteAccount } from './DeleteAccount'
import * as accountApi from '../api'
import * as authApi from '../../platform/api'
import { useShellStore } from '../../platform/stores/shell'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  getRemovalPreview: vi.fn(),
  removeMyAccount: vi.fn(),
}))

vi.mock('../../platform/api', async (importOriginal) => ({
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
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', confirmWith: 'password', permissions: { 'manage-own-account': true } } as never)
  })

  it('removes the account only once the email and the password are typed, then signs out', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [] })
    vi.mocked(accountApi.removeMyAccount).mockResolvedValue({ state: 'running', done: [] })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }))
    const confirm = await screen.findByRole('textbox')
    const remove = screen.getByRole('button', { name: 'Delete my account' })
    fireEvent.change(confirm, { target: { value: 'bo' } })
    expect(remove).toBeDisabled()

    fireEvent.change(confirm, { target: { value: 'BO@example.com' } })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'my-own-password' } })
    fireEvent.click(remove)
    await waitFor(() => expect(useShellStore.getState().user).toBeNull())
    expect(accountApi.removeMyAccount).toHaveBeenCalledWith('BO@example.com', { password: 'my-own-password' })
  })

  it('shows what still stands in the way instead of the confirmation', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: ['the app "odoo" is still deployed; remove it first'] })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }))
    expect(await screen.findByText('the app "odoo" is still deployed; remove it first')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull()
  })
})

describe('deleting an account with two-factor sign-in on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', confirmWith: 'two-factor', permissions: { 'manage-own-account': true } } as never)
  })

  it('asks for a code it sends on request, never the password', async () => {
    vi.mocked(accountApi.getRemovalPreview).mockResolvedValue({ email: 'bo@example.com', blockers: [] })
    vi.mocked(accountApi.removeMyAccount).mockResolvedValue({ state: 'running', done: [] })
    const sent = vi.spyOn(accountApi, 'sendConfirmCode').mockResolvedValue(undefined)
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }))
    const [confirm, code] = await screen.findAllByRole('textbox')
    expect(screen.queryByLabelText('Your password')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }))
    await waitFor(() => expect(sent).toHaveBeenCalled())
    fireEvent.change(confirm!, { target: { value: 'bo@example.com' } })
    fireEvent.change(code!, { target: { value: '12a3456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    await waitFor(() => expect(accountApi.removeMyAccount).toHaveBeenCalledWith('bo@example.com', { code: '123456' }))
  })
})

describe('deleting your account from inside an instance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', permissions: { 'manage-own-account': false } } as never)
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

