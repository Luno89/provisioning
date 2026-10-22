import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Memories from './Memories'

vi.mock('../api/memories', async () => {
  const actual = await vi.importActual<typeof import('../api/memories')>('../api/memories')
  return {
    ...actual,
    listMemories: vi.fn(),
    getConsolidation: vi.fn(async () => null),
    createMemory: vi.fn(async () => ({})),
    updateMemory: vi.fn(async () => ({})),
  }
})
vi.mock('../features/models/api', async () => {
  const actual = await vi.importActual<typeof import('../features/models/api')>('../features/models/api')
  return {
    ...actual,
    listModels: vi.fn(async () => [
      { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'qwen/q' },
      { id: 'or-1', name: 'Catalogue', source: 'endpoint', model: 'never/used' },
    ]),
    getDefaultModel: vi.fn(async () => ({ defaultModelId: null, globalModelOverride: false })),
  }
})

const { listMemories, createMemory, updateMemory } = await import('../api/memories')

const memory = (id: string, title: string, model?: string) => ({
  id, ownerId: 'u', category: 'lessons_learned', scope: 'global', status: 'active', title, text: `${title} text`, createdAt: 'a', updatedAt: 'a', ...(model ? { model } : {}),
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><Memories /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listMemories).mockResolvedValue([memory('m1', 'Quote arguments', 'qwen/q'), memory('m2', 'Old habit', 'old/m'), memory('m3', 'Repo layout')])
})

describe('memories by model', () => {
  it('marks a memory kept for one model and shows what a model recalls', async () => {
    show()
    expect(await screen.findByText('only for qwen/q')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Which model' }), 'qwen/q')
    expect(screen.getByText('Quote arguments')).toBeInTheDocument()
    expect(screen.getByText('Repo layout')).toBeInTheDocument()
    expect(screen.queryByText('Old habit')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /never\/used/ })).not.toBeInTheDocument()
  })

  it('keeps a new memory for one model, and lets an edit make it hold for every model', async () => {
    show()
    await screen.findByText('Repo layout')
    await userEvent.click(screen.getByRole('button', { name: /Add Memory/ }))
    await userEvent.type(screen.getByPlaceholderText(/Short title/), 'Tool calls')
    await userEvent.type(screen.getByPlaceholderText(/Detailed explanation/), 'Send arguments as an object.')
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'qwen/q')
    await userEvent.click(screen.getByRole('button', { name: 'Save Memory' }))
    await waitFor(() => expect(createMemory).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tool calls', model: 'qwen/q' })))

    await userEvent.click(screen.getAllByTitle('Edit memory')[0]!)
    expect(screen.getByLabelText('Model')).toHaveValue('qwen/q')
    await userEvent.selectOptions(screen.getByLabelText('Model'), '')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateMemory).toHaveBeenCalledWith('m1', expect.objectContaining({ model: null })))
  })
})
