import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FirstModel } from './FirstModel'
import * as modelsApi from '../api/models'
import * as agentsApi from '../features/machines/api'

vi.mock('../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  listModels: vi.fn(),
  getDefaultModel: vi.fn(),
  setDefaultModel: vi.fn(),
}))

vi.mock('../features/machines/api', async (importOriginal) => ({
  ...(await importOriginal<typeof agentsApi>()),
  useLocalAgentDevices: vi.fn(() => ({ data: [] })),
}))

const free = { promptPerMTok: 0, completionPerMTok: 0 }
const model = (id: string, extra: Partial<modelsApi.ModelProvider> = {}) => ({ id, name: id, source: 'endpoint', model: id, ...extra }) as modelsApi.ModelProvider

const renderIt = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><FirstModel /></QueryClientProvider>)
}

describe('a person with no model yet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  it('is offered Connect OpenRouter when they have no model at all', async () => {
    vi.mocked(modelsApi.listModels).mockResolvedValue([])
    vi.mocked(modelsApi.getDefaultModel).mockResolvedValue({ defaultModelId: null, globalModelOverride: false })
    renderIt()
    const connect = await screen.findByRole('link', { name: 'Connect OpenRouter' })
    expect(connect.getAttribute('href')).toMatch(/\/credentials\/llm\/openrouter\/connect$/)
  })

  it('once connected, picks among free models first, with paid ones kept apart, and the pick becomes the default', async () => {
    vi.mocked(modelsApi.listModels).mockResolvedValue([model('free/one', { pricing: free }), model('paid/one', { pricing: { promptPerMTok: 3, completionPerMTok: 15 } })])
    vi.mocked(modelsApi.getDefaultModel).mockResolvedValue({ defaultModelId: null, globalModelOverride: false })
    vi.mocked(modelsApi.setDefaultModel).mockResolvedValue('free/one')
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: /free\/one/ }))
    await waitFor(() => expect(modelsApi.setDefaultModel).toHaveBeenCalledWith('free/one'))
    expect(screen.getByText(/Paid, billed by their provider \(1\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /paid\/one/ })).not.toBeVisible()
  })

  it('shows nothing once a default is set', async () => {
    vi.mocked(modelsApi.listModels).mockResolvedValue([model('a')])
    vi.mocked(modelsApi.getDefaultModel).mockResolvedValue({ defaultModelId: 'a', globalModelOverride: false })
    const { container } = renderIt()
    await waitFor(() => expect(modelsApi.getDefaultModel).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('goes away for the session when put off', async () => {
    vi.mocked(modelsApi.listModels).mockResolvedValue([])
    vi.mocked(modelsApi.getDefaultModel).mockResolvedValue({ defaultModelId: null, globalModelOverride: false })
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sessionStorage.getItem('koala.firstModel.later')).toBe('1')
  })

  it('is shown the two other ways in, their own model and their own subscription, each leading to adding a machine', async () => {
    vi.mocked(modelsApi.listModels).mockResolvedValue([])
    vi.mocked(modelsApi.getDefaultModel).mockResolvedValue({ defaultModelId: null, globalModelOverride: false })
    renderIt()
    expect(await screen.findByRole('heading', { name: 'A model on your own machine' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'A subscription you already have' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Add my machine' }).map((link) => link.getAttribute('href'))).toEqual(['#/infrastructure/hardware', '#/mesh'])
  })

  it('picks a ready agent on their machine as the default, and is satisfied by it', async () => {
    vi.mocked(modelsApi.listModels).mockResolvedValue([])
    vi.mocked(modelsApi.getDefaultModel).mockResolvedValue({ defaultModelId: null, globalModelOverride: false })
    vi.mocked(modelsApi.setDefaultModel).mockResolvedValue('machine:d1:claude-code')
    vi.mocked(agentsApi.useLocalAgentDevices).mockReturnValue({ data: [{ id: 'd1', name: 'laptop', rootDir: '/home', createdAt: 't', online: true, manualAgents: [], agents: [{ id: 'claude-code', title: 'Claude Code', state: 'ready' }] }] } as never)
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: /Claude Code/ }))
    await waitFor(() => expect(modelsApi.setDefaultModel).toHaveBeenCalledWith('machine:d1:claude-code'))
  })
})
