import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as accountApi from '../api'
import { useShellStore } from '../../platform/stores/shell'
import { TwoFactorSettings } from './TwoFactorSettings'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  saveTwoFactor: vi.fn(),
  sendConfirmCode: vi.fn(),
}))

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TwoFactorSettings /></QueryClientProvider>)

describe('two-factor sign-in in Settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('turns it on only with the password, and keeps what the server saved', async () => {
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: false, confirmWith: 'password', permissions: { 'manage-own-account': true } } as never)
    vi.mocked(accountApi.saveTwoFactor).mockResolvedValue({ twoFactorEnabled: true, twoFactorPreferredMethod: 'email', confirmWith: 'two-factor' })
    show()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(screen.getByLabelText('Two-factor sign-in'))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'my-own-password' } })
    fireEvent.click(save)
    await waitFor(() => expect(accountApi.saveTwoFactor).toHaveBeenCalledWith({ enabled: true, preferredMethod: 'email' }, { password: 'my-own-password' }))
    await waitFor(() => expect(useShellStore.getState().user).toMatchObject({ twoFactorEnabled: true, confirmWith: 'two-factor' }))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('turns it off only with a current code', async () => {
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: true, twoFactorPreferredMethod: 'email', confirmWith: 'two-factor', permissions: { 'manage-own-account': true } } as never)
    vi.mocked(accountApi.saveTwoFactor).mockResolvedValue({ twoFactorEnabled: false, twoFactorPreferredMethod: 'email', confirmWith: 'password' })
    vi.mocked(accountApi.sendConfirmCode).mockResolvedValue(undefined)
    show()
    fireEvent.click(screen.getByLabelText('Two-factor sign-in'))
    expect(screen.queryByLabelText('Your password')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }))
    expect(await screen.findByText('Sent. It works for five minutes.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('A code from your two-factor sign-in'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(accountApi.saveTwoFactor).toHaveBeenCalledWith({ enabled: false, preferredMethod: 'email' }, { code: '654321' }))
  })

  it('shows nothing inside an instance, where the account is kept by root', () => {
    useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', permissions: { 'manage-own-account': false } } as never)
    show()
    expect(screen.queryByTestId('two-factor')).toBeNull()
  })
})
