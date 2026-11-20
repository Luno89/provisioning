import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NoInstance from './NoInstance'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
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
    vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
      if (url === '/instances/mine') return { data: { instance: null } }
      if (url === '/my-machines') return { data: { koala: null, machines: [{ id: 'desk', name: 'desk', rootDir: '/x', createdAt: 't', online: true, meshIp: '100.64.0.7', koalaWanted: false, holdsKoala: false }] } }
      return { data: names[(config?.params as { name?: string } | undefined)?.name ?? ''] ?? { ok: false } }
    })
    vi.mocked(api.post).mockImplementation(async (url: string) => (url.endsWith('/koala') ? { data: { placing: true } } : { data: { code: 'c', command: 'curl -fsSL https://root/machine.sh | sh -s -- c', expiresAt: new Date().toISOString() } }))
  })

  it('suggests a name, refuses a bad one, and for a good one adds a machine that puts Koala on itself', async () => {
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
    expect(await screen.findByRole('checkbox', { name: /Put my Koala on this machine/ })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /Add a machine/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/my-machines/join-code', { koalaName: 'luno' }))
    expect(await screen.findByText('curl -fsSL https://root/machine.sh | sh -s -- c')).toBeInTheDocument()
    expect(await screen.findByText('Waiting for your machine to run the command and connect')).toBeInTheDocument()
  })

  it('puts Koala on a machine already on the account', async () => {
    renderPage()
    await screen.findByText('https://luno.koala.dev')
    const make = screen.getByRole('button', { name: /Use my own machine/ })
    await waitFor(() => expect(make).toBeEnabled())
    fireEvent.click(make)
    fireEvent.click(await screen.findByRole('button', { name: 'Put Koala here' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/my-machines/desk/koala', { name: 'luno' }))
    expect(await screen.findByText('Your machine is putting Koala on itself')).toBeInTheDocument()
  })
})

describe('root\'s page when the owner\'s instance is not answering', () => {
  it('says so instead of sending them on, offers to try anyway, and switches the emails', async () => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/instances/mine') return { data: { instance: { id: 'inst-1', status: 'ready', url: 'https://luno.koala.dev', name: 'luno', watch: { notifyWhenUnreachable: true, reach: { reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true } } } } }
      return { data: { ok: false } }
    })
    const put = vi.fn(async () => ({ data: { notifyWhenUnreachable: false } }))
    ;(api as unknown as { put: typeof put }).put = put
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><NoInstance hasInstance unreachableSince="2026-10-29T10:00:00.000Z" onLogout={() => {}} /></QueryClientProvider>)
    expect(await screen.findByText('Your instance is not answering')).toBeInTheDocument()
    expect(screen.queryByText(/Taking you to your instance/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Try to open it anyway' })).toHaveAttribute('href', expect.stringMatching(/\/identity\/go$/))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Email me when my instance stops answering/ }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/instances/mine/watch', { notifyWhenUnreachable: false }))
  })
})

describe('root\'s page when the owner\'s instance has not named its sign-in key', () => {
  it('says so instead of sending them on', async () => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/instances/mine') return { data: { instance: { id: 'inst-1', status: 'ready', url: 'https://luno.koala.dev', name: 'luno' } } }
      return { data: { ok: false } }
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><NoInstance hasInstance signInWaiting="your Koala has not named its sign-in key to root yet; it does so as it starts" onLogout={() => {}} /></QueryClientProvider>)
    expect(await screen.findByText('Your Koala is not ready for sign-in yet')).toBeInTheDocument()
    expect(screen.getByText(/your Koala has not named its sign-in key to root yet; it does so as it starts/)).toBeInTheDocument()
    expect(screen.queryByText(/Taking you to your instance/)).toBeNull()
  })
})
