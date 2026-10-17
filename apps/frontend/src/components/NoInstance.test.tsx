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
