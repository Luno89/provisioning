import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ModelSelector from './ModelSelector'
import * as modelsApi from '../../api'

vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof modelsApi>()),
  listModels: vi.fn(),
  useDefaultModel: vi.fn(),
}))

const mockModels: modelsApi.ModelProvider[] = [
  {
    id: 'tabby-local',
    name: 'Tabbyapi-Production',
    model: 'turboderp/Qwen3.8-27B-exl3',
    source: 'deployment',
    kind: 'tabbyapi',
    clusterId: 'c1',
    gpuCount: 1,
  },
  {
    id: 'openai-gpt4',
    name: 'GPT-4o',
    model: 'gpt-4o',
    source: 'endpoint',
    sourceLabel: 'OpenAI',
  },
]

const renderSelector = (props: Partial<React.ComponentProps<typeof ModelSelector>> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = vi.fn()
  const res = render(
    <QueryClientProvider client={qc}>
      <ModelSelector value={null} onChange={onChange} {...props} />
    </QueryClientProvider>,
  )
  return { ...res, onChange }
}

describe('ModelSelector popover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(modelsApi.listModels).mockResolvedValue(mockModels)
    vi.mocked(modelsApi.useDefaultModel).mockReturnValue({
      data: { defaultModelId: 'tabby-local', globalModelOverride: false },
    } as never)
  })

  it('renders trigger button showing account default by default', async () => {
    renderSelector()
    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent(/Account default · Tabbyapi-Production/)
    })
  })

  it('opens popover when clicked and shows categories', async () => {
    renderSelector()
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText(/Local & Cluster Deployments/i)).toBeInTheDocument()
      expect(screen.getByText('Tabbyapi-Production')).toBeInTheDocument()
      expect(screen.getByText(/Connected Gateways/i)).toBeInTheDocument()
      expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    })
  })

  it('filters models when search text is typed', async () => {
    renderSelector()
    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(screen.getByText('Tabbyapi-Production')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search models/i)
    fireEvent.change(searchInput, { target: { value: 'tabby' } })

    expect(screen.getByText('Tabbyapi-Production')).toBeInTheDocument()
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument()
  })

  it('calls onChange with selected model and closes popover', async () => {
    const { onChange } = renderSelector()
    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(screen.getByText('Tabbyapi-Production')).toBeInTheDocument()
    })

    const tabbyBtn = screen.getByText('Tabbyapi-Production').closest('button')!
    fireEvent.click(tabbyBtn)

    expect(onChange).toHaveBeenCalledWith('tabby-local', expect.objectContaining({ id: 'tabby-local' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows on the closed trigger whether the chosen model runs on a cluster of yours or through a gateway', async () => {
    const { unmount } = renderSelector({ value: 'tabby-local' })
    const local = screen.getByRole('button', { name: 'Model' })
    await waitFor(() => expect(local).toHaveTextContent('Tabbyapi-Production · turboderp/Qwen3.8-27B-exl3Cluster'))
    expect(local.querySelector('.lucide-server')).not.toBeNull()
    unmount()

    renderSelector({ value: 'openai-gpt4' })
    const gateway = screen.getByRole('button', { name: 'Model' })
    await waitFor(() => expect(gateway).toHaveTextContent('GPT-4o · gpt-4oOpenAI'))
    expect(gateway.querySelector('.lucide-globe')).not.toBeNull()
  })

  it('allows selecting Account Default (empty value)', () => {
    const { onChange } = renderSelector({ value: 'openai-gpt4' })
    fireEvent.click(screen.getByRole('button'))

    const defaultBtn = screen.getByText('Account Default').closest('button')!
    fireEvent.click(defaultBtn)

    expect(onChange).toHaveBeenCalledWith('', undefined)
  })
})
