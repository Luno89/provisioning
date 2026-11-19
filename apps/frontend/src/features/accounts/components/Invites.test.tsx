import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Invites } from './Invites'
import * as accountApi from '../api'
import { refused } from '../../../test/refused'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  listInvites: vi.fn(),
  mintInvite: vi.fn(),
}))

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Invites /></QueryClientProvider>)

describe('the invites an operator makes', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says why the invites could not be listed, rather than that there are none', async () => {
    vi.mocked(accountApi.listInvites).mockRejectedValue(refused(403, { error: 'Admin only' }))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin only')
    expect(screen.queryByText('No invites generated yet.')).toBeNull()
  })

  it('says why no invite was made, and shows no code', async () => {
    vi.mocked(accountApi.listInvites).mockResolvedValue([])
    vi.mocked(accountApi.mintInvite).mockRejectedValue(refused(500, { error: 'store gone' }))
    show()
    await screen.findByText('No invites generated yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Generate invite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('store gone')
    expect(screen.queryByTestId('new-invite')).toBeNull()
  })
})
