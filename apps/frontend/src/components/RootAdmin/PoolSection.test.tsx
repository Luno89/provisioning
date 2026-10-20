import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PoolAdmin from './PoolAdmin'
import { api } from '../api/client'

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }
})

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><PoolAdmin onLogout={() => {}} /></QueryClientProvider>)
}

describe('the pool, for an admin on root', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({ data: {
      slots: 4, trialDays: 14, defaultTrialDays: 14,
      instances: [
        { id: 'inst-1', name: 'alice', owner: 'alice@example.com', status: 'ready', startedAt: '2026-10-20T07:00:00.000Z', trialEndsAt: '2026-11-03T07:00:00.000Z' },
        { id: 'inst-2', name: 'bob', owner: 'bob@example.com', status: 'paused', startedAt: '2026-09-01T07:00:00.000Z', trialEndsAt: '2026-09-15T07:00:00.000Z', pausedAt: '2026-09-15T07:00:00.000Z' },
      ],
    } })
    vi.mocked(api.put).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: { removing: 'bob' } })
  })

  it('lists who is trying Koala, how far along, and how many places are taken', async () => {
    renderPage()
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('2 of 4 places in use.')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('stopped, trial ended')).toBeInTheDocument()
  })

  it('moves one person\'s trial end, keeping the time of day it had', async () => {
    renderPage()
    const end = await screen.findByLabelText('Trial end for bob')
    fireEvent.change(end, { target: { value: '2026-11-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/instances/pool/admin/instances/inst-2/trial', { trialEndsAt: '2026-11-30T07:00:00.000Z' }))
  })

  it('changes how long new trials last', async () => {
    renderPage()
    const days = await screen.findByLabelText('How long a new trial lasts, in days')
    fireEvent.change(days, { target: { value: '21' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/instances/pool/admin/trial-days', { days: 21 }))
  })

  it('deletes one only once its name is typed', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete bob' }))
    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type bob to delete it'), { target: { value: 'bob' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/instances/pool/admin/instances/inst-2', { data: { confirm: 'bob' } }))
  })
})
