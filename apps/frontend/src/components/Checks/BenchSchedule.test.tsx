import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BenchSchedule from './BenchSchedule'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, getBench: vi.fn(), saveBench: vi.fn() }
})

const { getBench, saveBench } = await import('../../api/evals')

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><BenchSchedule /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getBench).mockResolvedValue({ settings: { enabled: true, idleMinutes: 15, fullEveryHours: 24 }, state: { benched: {}, lastFullAt: '2026-10-03T08:00:00Z' } })
})

describe('the bench schedule', () => {
  it('saves when it runs, keeping whether it is paused as it is now', async () => {
    vi.mocked(saveBench).mockResolvedValue({ enabled: true, idleMinutes: 30, fullEveryHours: 24 })
    show()

    const minutes = await screen.findByRole('spinbutton', { name: 'Idle minutes before the bench runs' })
    await userEvent.clear(minutes)
    await userEvent.type(minutes, '30')

    vi.mocked(getBench).mockResolvedValue({ settings: { enabled: false, idleMinutes: 15, fullEveryHours: 24 }, state: { benched: {} } })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveBench).toHaveBeenCalledWith({ enabled: false, idleMinutes: 30, fullEveryHours: 24 }))
  })
})
