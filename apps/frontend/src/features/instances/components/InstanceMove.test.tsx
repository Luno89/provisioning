import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InstanceMove, MovingPage } from './InstanceMove'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }
})

let move: unknown
const show = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

describe('moving an instance off Koala\'s servers, from inside it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    move = null
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/instance-trial') return { data: { trialEndsAt: '2026-11-03T12:00:00.000Z' } }
      if (url === '/instance-trial/move') return { data: { move } }
      throw new Error(url)
    })
    vi.mocked(api.post).mockImplementation(async () => {
      move = { state: 'waiting', startedAt: 'now', detail: 'Waiting for your machine to run the move command' }
      return { data: { command: 'curl -fsSL https://app.koala.dev/install.sh | sudo sh -s -- abc', expiresAt: 'later' } }
    })
    vi.mocked(api.delete).mockResolvedValue({ data: { stopping: true } })
  })

  it('gives the move command, says what it is waiting for, and stops it', async () => {
    show(<InstanceMove />)
    fireEvent.click(await screen.findByRole('button', { name: 'Move to my own machine' }))
    expect(await screen.findByText('curl -fsSL https://app.koala.dev/install.sh | sudo sh -s -- abc')).toBeInTheDocument()
    expect(await screen.findByText('Waiting for your machine')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop the move' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/instance-trial/move'))
  })

  it('is not offered on an instance of the person\'s own', async () => {
    vi.mocked(api.get).mockImplementation(async () => ({ data: {} }))
    const { container } = show(<InstanceMove />)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/instance-trial'))
    expect(container).toBeEmptyDOMElement()
  })

  it('covers the instance while it copies, naming the machine it goes to', async () => {
    move = { state: 'copying', startedAt: 'now', machine: 'bo-desktop', detail: 'Copying its repositories and images' }
    show(<MovingPage />)
    expect(await screen.findByText('Your instance is moving to bo-desktop')).toBeInTheDocument()
    expect(screen.getByText(/Copying its repositories and images/)).toBeInTheDocument()
  })
})
