import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OtherSessions } from './OtherSessions'
import { useShellStore } from '../../platform'
import * as api from '../api'

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), endOtherSessions: vi.fn(async () => undefined) }))

const show = () => render(<QueryClientProvider client={new QueryClient()}><OtherSessions /></QueryClientProvider>)

describe('signing out everywhere else', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShellStore.setState({ user: { id: 'u1', email: 'a@b.c', holdsAccounts: true } as never })
  })

  it('ends every other session when asked, and says so', async () => {
    const pushed = vi.spyOn(useShellStore.getState(), 'pushNotification')
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere else' }))
    await waitFor(() => expect(api.endOtherSessions).toHaveBeenCalledOnce())
    await waitFor(() => expect(pushed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('signed out') })))
  })

  it('is not offered on an instance, whose sessions come from root', () => {
    useShellStore.setState({ user: { id: 'u1', email: 'a@b.c', holdsAccounts: false } as never })
    show()
    expect(screen.queryByRole('button', { name: 'Sign out everywhere else' })).toBeNull()
  })
})
