import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as accountApi from '../api'
import * as authApi from '../../platform/api'
import Login from './Login'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  forgotPassword: vi.fn(),
  resendPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}))

vi.mock('../../platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof authApi>()),
  signInPlace: vi.fn(),
}))

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Login onSuccess={() => {}} /></QueryClientProvider>)

describe('forgetting a password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authApi.signInPlace).mockResolvedValue({ url: null, providers: [] })
  })

  it('asks for the address, then the emailed code with a new password typed twice, and goes back to sign in once reset', async () => {
    vi.mocked(accountApi.forgotPassword).mockResolvedValue({ reset: 'r1' })
    vi.mocked(accountApi.resetPassword).mockResolvedValue({ email: 'ann@example.com' })
    show()
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'ann@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.getByLabelText('Email address')).toHaveValue('ann@example.com')
    fireEvent.click(screen.getByRole('button', { name: /email me a code/i }))
    expect(await screen.findByText(/If ann@example.com has an account, we sent it a six-digit code/)).toBeInTheDocument()
    expect(accountApi.forgotPassword).toHaveBeenCalledWith('ann@example.com')

    const submit = screen.getByRole('button', { name: /reset password/i })
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '123456' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } })
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'short' } })
    expect(screen.getByText('Use at least 12 characters')).toBeInTheDocument()
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-brand-new-password' } })
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-brand-new-password' } })
    fireEvent.click(submit)
    await waitFor(() => expect(accountApi.resetPassword).toHaveBeenCalledWith({ id: 'r1', code: '123456', password: 'a-brand-new-password' }))
    expect(await screen.findByText(/Your password is changed and every session of your account is signed out/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('shows the code a server that sends no email hands back, and starts again once the reset has ended', async () => {
    vi.mocked(accountApi.forgotPassword).mockResolvedValue({ reset: 'r2', devCode: '654321' })
    vi.mocked(accountApi.resetPassword).mockRejectedValue(Object.assign(new Error('gone'), { response: { status: 410, data: { error: 'This password reset has ended; ask for a new one' } } }))
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'bo@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /email me a code/i }))
    expect(await screen.findByText(/here is the code: 654321/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '654321' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-brand-new-password' } })
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-brand-new-password' } })
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }))
    expect(await screen.findByText('This password reset has ended; ask for a new one')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /email me a code/i })).toBeInTheDocument()
  })
})
