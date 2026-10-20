import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TrialBanner from './TrialBanner'
import { api } from '../api/client'

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, api: { get: vi.fn() } }
})

const renderBanner = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><TrialBanner /></QueryClientProvider>)
}

describe('the trial, shown inside a pool instance', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says when the trial ends, how many days are left, and until when the work is kept', async () => {
    const ends = new Date(Date.now() + 3.5 * 86_400_000).toISOString()
    vi.mocked(api.get).mockResolvedValue({ data: { trialEndsAt: ends } })
    renderBanner()
    expect(await screen.findByRole('status')).toHaveTextContent(/trial that ends on .*, in 4 days\./)
    expect(screen.getByRole('status')).toHaveTextContent(/its work is kept until/)
    expect(api.get).toHaveBeenCalledWith('/instance-trial')
  })

  it('shows nothing on an instance that is not on a trial', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    const { container } = renderBanner()
    await new Promise((settle) => setTimeout(settle, 20))
    expect(container).toBeEmptyDOMElement()
  })
})
