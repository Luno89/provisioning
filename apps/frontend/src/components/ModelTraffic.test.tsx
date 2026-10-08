import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ModelTraffic from './ModelTraffic'
import * as modelsApi from '../api/models'

vi.mock('../api/models', async (orig) => ({ ...(await orig<typeof import('../api/models')>()), getModelTraffic: vi.fn() }))

const now = Date.parse('2026-10-05T12:00:00.000Z')
const renderTraffic = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ModelTraffic now={() => now} /></QueryClientProvider>)

describe('model traffic', () => {
  it('shows each model answering, waiting or paused, with its totals', async () => {
    vi.mocked(modelsApi.getModelTraffic).mockResolvedValue([
      { key: 'tabby', label: 'Tabbyapi-Production', inFlight: 1, queued: 2, totalRequests: 40, total429: 0, totalErrors: 1, lastStatus: 200 },
      { key: 'or', label: 'OpenRouter · glm', inFlight: 0, queued: 0, cooldownUntil: '2026-10-05T12:00:12.000Z', totalRequests: 3, total429: 1, totalErrors: 0, lastStatus: 429 },
    ])

    renderTraffic()

    expect(await screen.findByText('Tabbyapi-Production')).toBeInTheDocument()
    expect(screen.getByText('answering')).toBeInTheDocument()
    expect(screen.getByText('paused 12s')).toBeInTheDocument()
    expect(screen.getByText('429')).toBeInTheDocument()
  })

  it('says when nothing has been called yet', async () => {
    vi.mocked(modelsApi.getModelTraffic).mockResolvedValue([])
    renderTraffic()
    expect(await screen.findByText('No model has been called since the server started.')).toBeInTheDocument()
  })
})
