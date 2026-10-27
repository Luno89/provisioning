import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectInvites } from './ProjectInvites'
import * as accountApi from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof accountApi>()),
  getProjectInviteLimits: vi.fn(),
  setProjectInviteLimits: vi.fn(),
  setOwnInviteAccounts: vi.fn(),
}))

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ProjectInvites /></QueryClientProvider>)
}

describe('how many new people a person\'s project invites may bring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(accountApi.getProjectInviteLimits).mockResolvedValue({
      accounts: 10,
      perHour: 20,
      people: [{ id: 'ann', email: 'ann@example.com', made: 10 }, { id: 'bo', email: 'bo@example.com', made: 1, own: 3 }],
    })
  })

  it('shows each person against their allowance, the default or their own', async () => {
    renderSection()
    expect(await screen.findByText('10 of 10 (the default)')).toBeInTheDocument()
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect((screen.getByLabelText('New people each person may bring') as HTMLInputElement).value).toBe('10')
    expect((screen.getByLabelText('Invites a person may send an hour') as HTMLInputElement).value).toBe('20')
  })

  it('saves new defaults, and only whole numbers', async () => {
    vi.mocked(accountApi.setProjectInviteLimits).mockResolvedValue({ accounts: 5, perHour: 20 })
    renderSection()
    const save = await screen.findByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New people each person may bring'), { target: { value: 'five' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New people each person may bring'), { target: { value: '5' } })
    fireEvent.click(save)
    await waitFor(() => expect(accountApi.setProjectInviteLimits).toHaveBeenCalledWith({ accounts: 5, perHour: 20 }))
  })

  it('gives one person their own allowance, and puts them back on the default', async () => {
    vi.mocked(accountApi.setOwnInviteAccounts).mockResolvedValue({ id: 'ann', email: 'ann@example.com', made: 10, own: 15 })
    renderSection()
    fireEvent.change(await screen.findByLabelText('New people ann@example.com may bring'), { target: { value: '15' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Set' })[0]!)
    await waitFor(() => expect(accountApi.setOwnInviteAccounts).toHaveBeenCalledWith('ann', 15))
    fireEvent.click(screen.getByRole('button', { name: 'Use the default' }))
    await waitFor(() => expect(accountApi.setOwnInviteAccounts).toHaveBeenCalledWith('bo', null))
  })
})
