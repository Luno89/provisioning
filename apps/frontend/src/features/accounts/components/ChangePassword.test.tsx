import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as accountApi from '../api'
import { useShellStore } from '../../platform/stores/shell'
import { ChangePassword } from './ChangePassword'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  changePassword: vi.fn(),
  sendConfirmCode: vi.fn(),
}))

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChangePassword /></QueryClientProvider>)

const signedIn = (extra: Record<string, unknown>) =>
  useShellStore.getState().setUser({ id: 'bo', email: 'bo@example.com', hasPassword: true, permissions: { 'manage-own-account': true }, ...extra } as never)

describe('changing a password in Settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for the current password and the new one twice', async () => {
    signedIn({ twoFactorEnabled: false })
    vi.mocked(accountApi.changePassword).mockResolvedValue(undefined)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const submit = screen.getAllByRole('button', { name: 'Change password' }).at(-1)!
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-brand-new-password' } })
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-brand-new-password' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the-old-password' } })
    fireEvent.click(submit)
    await waitFor(() => expect(accountApi.changePassword).toHaveBeenCalledWith({ password: 'a-brand-new-password', current: 'the-old-password' }))
  })

  it('asks a code as well with two-factor sign-in on, and says what the server refused', async () => {
    signedIn({ twoFactorEnabled: true })
    vi.mocked(accountApi.sendConfirmCode).mockResolvedValue(undefined)
    vi.mocked(accountApi.changePassword).mockRejectedValue(Object.assign(new Error('no'), { response: { status: 403, data: { error: 'That is not your current password' } } }))
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the-old-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-brand-new-password' } })
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-brand-new-password' } })
    const submit = screen.getAllByRole('button', { name: 'Change password' }).at(-1)!
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }))
    await waitFor(() => expect(accountApi.sendConfirmCode).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('A code from your two-factor sign-in'), { target: { value: '123456' } })
    fireEvent.click(submit)
    expect(await screen.findByText('That is not your current password')).toBeInTheDocument()
    expect(accountApi.changePassword).toHaveBeenCalledWith({ password: 'a-brand-new-password', current: 'the-old-password', code: '123456' })
  })

  it('lets an account with no password set one with an emailed code', async () => {
    signedIn({ hasPassword: false, twoFactorEnabled: false })
    vi.mocked(accountApi.changePassword).mockResolvedValue(undefined)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Set a password' }))
    expect(screen.queryByLabelText('Current password')).toBeNull()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-brand-new-password' } })
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-brand-new-password' } })
    fireEvent.change(screen.getByLabelText('The code we email you'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(accountApi.changePassword).toHaveBeenCalledWith({ password: 'a-brand-new-password', code: '123456' }))
  })
})
