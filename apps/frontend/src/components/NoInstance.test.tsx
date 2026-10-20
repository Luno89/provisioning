import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NoInstance from './NoInstance'
import { api } from '../api/client'

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, api: { get: vi.fn(), post: vi.fn() } }
})

const names: Record<string, object> = {
  '': { ok: false, suggestion: 'luno' },
  luno: { ok: true, address: 'https://luno.koala.dev' },
  'luno-x': { ok: false, problem: 'a name has no dashes' },
}

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><NoInstance hasInstance={false} onLogout={() => {}} /></QueryClientProvider>)
}

describe('choosing a name before bringing a machine in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: { name?: string } }) => {
      if (url === '/instances/mine') return { data: { instance: null } }
      if (url === '/instances/pool') return { data: { available: false, reason: 'this root has no pool' } }
      return { data: names[config?.params?.name ?? ''] ?? { ok: false } }
    })
    vi.mocked(api.post).mockResolvedValue({ data: { token: 't', command: 'curl … | sudo sh -s -- t', expiresAt: new Date().toISOString() } })
  })

  it('suggests a name, refuses a bad one, and makes the command for a good one', async () => {
    renderPage()
    const field = await screen.findByDisplayValue('luno')
    expect(await screen.findByText('https://luno.koala.dev')).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'luno-x' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('no dashes')
    expect(screen.getByRole('button', { name: /Use my own machine/ })).toBeDisabled()

    fireEvent.change(field, { target: { value: 'luno' } })
    const make = screen.getByRole('button', { name: /Use my own machine/ })
    await waitFor(() => expect(make).toBeEnabled())
    fireEvent.click(make)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/instances/join-tokens', { name: 'luno' }))
  })
})

describe('trying Koala on its own servers', () => {
  let mine: object | null
  let offer: object

  beforeEach(() => {
    vi.clearAllMocks()
    mine = null
    offer = { available: true, trialDays: 14 }
    vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: { name?: string } }) => {
      if (url === '/instances/mine') return { data: { instance: mine } }
      if (url === '/instances/pool') return { data: offer }
      return { data: names[config?.params?.name ?? ''] ?? { ok: false } }
    })
    vi.mocked(api.post).mockImplementation(async () => {
      mine = { id: 'inst-1', status: 'installing', url: '', name: 'luno', detail: 'Making your space on Koala\'s servers', trialEndsAt: '2026-11-03T00:00:00.000Z' }
      return { data: { id: 'inst-1', name: 'luno', trialEndsAt: '2026-11-03T00:00:00.000Z' } }
    })
  })

  it('offers the trial with how long it lasts, then shows its install under the name picked', async () => {
    renderPage()
    expect(await screen.findByText(/free for 14 days/)).toBeInTheDocument()
    const start = await screen.findByRole('button', { name: /Try it on Koala's servers/ })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/instances/pool', { name: 'luno' }))
    expect(await screen.findByText('Setting up your instance on Koala\'s servers')).toBeInTheDocument()
    expect(screen.getByText(/keeping all your work/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use my own machine/ })).not.toBeInTheDocument()
  })

  it('says why when the servers are full, and still offers the person\'s own machine', async () => {
    offer = { available: false, reason: 'Koala\'s servers are full right now; use your own machine, or try again later', trialDays: 14 }
    renderPage()
    expect(await screen.findByText(/servers are full right now/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Try it on Koala's servers/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Use my own machine/ })).toBeInTheDocument()
  })

  it('picks up an install already under way, and offers to try again once it failed', async () => {
    mine = { id: 'inst-1', status: 'failed', url: '', name: 'luno', detail: 'the pool\'s node has no gVisor runtime yet', trialEndsAt: '2026-11-03T00:00:00.000Z' }
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('no gVisor runtime yet')
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/instances/pool', { name: 'luno' }))
  })
})
