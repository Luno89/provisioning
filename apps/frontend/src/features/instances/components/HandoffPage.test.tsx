import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HandoffPage from './HandoffPage'

vi.mock('../../platform/api', async () => {
  const actual = await vi.importActual<typeof import('../../platform/api')>('../../platform/api')
  return { ...actual, exchangeHandoff: vi.fn(), signInElsewhere: vi.fn() }
})

const { exchangeHandoff } = await import('../../platform/api')

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

  it('starts the sign-in here when the instance asks, carrying where the person was going', async () => {
    vi.mocked(exchangeHandoff).mockImplementation(async () => { throw Object.assign(new Error('Request failed'), { response: { status: 401, data: { error: 'this sign-in has to start here first', restart: true } } }) })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    render(<HandoffPage token="unbound" next="/hub/join/abc" onSignedIn={vi.fn()} />)

    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/handoff\/start\?next=%2Fhub%2Fjoin%2Fabc$/)))
    expect(screen.queryByText('this sign-in has to start here first')).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('does not try anything without a token', () => {
    render(<HandoffPage token={null} onSignedIn={vi.fn()} />)
    expect(screen.getByText('There is no sign-in token in this link.')).toBeInTheDocument()
    expect(exchangeHandoff).not.toHaveBeenCalled()
  })
})
