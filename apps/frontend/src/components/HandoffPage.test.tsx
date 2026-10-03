import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HandoffPage from './HandoffPage'

vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth')
  return { ...actual, exchangeHandoff: vi.fn(), signInElsewhere: vi.fn() }
})

const { exchangeHandoff } = await import('../api/auth')

beforeEach(() => { vi.mocked(exchangeHandoff).mockReset() })

describe('landing on an instance from root', () => {
  it('trades the token for a session here and signs the owner in', async () => {
    vi.mocked(exchangeHandoff).mockResolvedValue({ id: 'u1', email: 'u1@example.com' })
    const onSignedIn = vi.fn()
    render(<HandoffPage token="tok" onSignedIn={onSignedIn} />)

    expect(screen.getByText(/Signing you in/)).toBeInTheDocument()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ id: 'u1', email: 'u1@example.com' }))
    expect(exchangeHandoff).toHaveBeenCalledWith('tok')
  })

  it('says why it could not, and offers to sign in again', async () => {
    vi.mocked(exchangeHandoff).mockImplementation(async () => { throw Object.assign(new Error('Request failed'), { response: { data: { error: 'that sign-in token has expired — sign in again' } } }) })
    render(<HandoffPage token="old" onSignedIn={vi.fn()} />)

    expect(await screen.findByText('that sign-in token has expired — sign in again')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument()
  })

  it('does not try anything without a token', () => {
    render(<HandoffPage token={null} onSignedIn={vi.fn()} />)
    expect(screen.getByText('There is no sign-in token in this link.')).toBeInTheDocument()
    expect(exchangeHandoff).not.toHaveBeenCalled()
  })
})
