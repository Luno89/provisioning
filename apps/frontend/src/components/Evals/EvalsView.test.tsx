import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EvalsView from './EvalsView'
import type { EvalRun } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return {
    ...actual,
    listCases: vi.fn(),
    listModels: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(),
    startRun: vi.fn(),
    cancelRun: vi.fn(async () => undefined),
  }
})

const { listCases, listModels, getRun, startRun, cancelRun } = await import('../../api/evals')

const CASES = {
  cases: [
    { name: 'read/by-name', category: 'simple' as const, agent: 'agent-builder', say: 'Show me research.', expects: 'read_agent' },
    { name: 'irrelevance/answers', category: 'irrelevance' as const, agent: 'agent-builder', say: 'What is an agent?', expects: null },
  ],
  coverage: [{ case: 'write_agent', message: 'nothing provokes "the text does not compile"' }],
}

const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: 'run-1',
  state: 'done',
  startedAt: '2026-01-01T00:00:00.000Z',
  repeats: 5,
  total: 2,
  finished: 2,
  outcomes: [],
  ...over,
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <EvalsView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listCases).mockResolvedValue(CASES)
  vi.mocked(listModels).mockResolvedValue([])
})

describe('EvalsView', () => {
  it('lists each case with what it should call', async () => {
    show()

    expect(await screen.findByText('read/by-name')).toBeInTheDocument()
    expect(screen.getByText('read_agent')).toBeInTheDocument()
    expect(screen.getByText('calls nothing')).toBeInTheDocument()
  })

  it('says what the case asks the agent', async () => {
    show()
    expect(await screen.findByText('Show me research.')).toBeInTheDocument()
  })

  it('surfaces what nothing checks yet, rather than hiding it', async () => {
    show()

    expect(await screen.findByText('1 things nothing checks yet')).toBeInTheDocument()
  })

  it('runs every case when none are singled out', async () => {
    vi.mocked(startRun).mockResolvedValue(run({ state: 'running', finished: 0 }))
    vi.mocked(getRun).mockResolvedValue(run({ state: 'running', finished: 0 }))
    show()

    await userEvent.click(await screen.findByRole('button', { name: /Run 2 cases/ }))

    await waitFor(() => expect(vi.mocked(startRun).mock.calls[0]?.[0]).toMatchObject({ repeats: 5 }))
    expect(vi.mocked(startRun).mock.calls[0]?.[0]).not.toHaveProperty('only')
  })

  it('runs only what you picked', async () => {
    vi.mocked(startRun).mockResolvedValue(run())
    vi.mocked(getRun).mockResolvedValue(run())
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'None' }))
    await userEvent.click(screen.getByLabelText('Include read/by-name'))
    await userEvent.click(screen.getByRole('button', { name: /Run 1 case$/ }))

    await waitFor(() => expect(vi.mocked(startRun).mock.calls[0]?.[0]).toMatchObject({
      only: ['read/by-name'],
    }))
  })

  it('shows how a case scored, and why it failed', async () => {
    vi.mocked(startRun).mockResolvedValue(run())
    vi.mocked(getRun).mockResolvedValue(run({
      outcomes: [{
        name: 'read/by-name',
        category: 'simple',
        attempts: 5,
        passed: 2,
        complaints: ['called no tool, answered instead: "let me think"'],
      }],
      reliability: { cases: 1, always: 0, never: 0, flaky: 1 },
    }))

    show()
    await userEvent.click(await screen.findByRole('button', { name: /Run 2 cases/ }))

    expect(await screen.findByText(/2\/5 · flaky/)).toBeInTheDocument()
    expect(screen.getByText(/called no tool, answered instead/)).toBeInTheDocument()
    expect(screen.getByText('1 flaky')).toBeInTheDocument()
  })

  it('offers a way to stop a run that is still going', async () => {
    vi.mocked(startRun).mockResolvedValue(run({ state: 'running' }))
    vi.mocked(getRun).mockResolvedValue(run({ state: 'running', finished: 1 }))

    show()
    await userEvent.click(await screen.findByRole('button', { name: /Run 2 cases/ }))

    const stop = await screen.findByRole('button', { name: 'Stop' })
    await userEvent.click(stop)

    await waitFor(() => expect(vi.mocked(cancelRun).mock.calls[0]?.[0]).toBe('run-1'))
  })

  it('shows a run that failed outright', async () => {
    vi.mocked(startRun).mockResolvedValue(run())
    vi.mocked(getRun).mockResolvedValue(run({ state: 'failed', error: 'no model endpoint is configured' }))

    show()
    await userEvent.click(await screen.findByRole('button', { name: /Run 2 cases/ }))

    expect(await screen.findByText('no model endpoint is configured')).toBeInTheDocument()
  })
})

describe('choosing what to run against', () => {
  it('offers the account default plus every model that is set up', async () => {
    vi.mocked(listModels).mockResolvedValue([
      { id: 'dep-1', name: 'tabbyapi-production', model: 'qwen3-27b', sourceLabel: 'TabbyAPI', source: 'deployment' },
      { id: 'ep-2', name: 'OpenRouter', model: 'sonnet', source: 'endpoint' },
    ])

    show()

    expect(await screen.findByRole('option', { name: /tabbyapi-production/ })).toBeInTheDocument()
    expect(screen.getByLabelText('Model')).toHaveValue('')
    expect(screen.getByRole('option', { name: /qwen3-27b/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /TabbyAPI/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /OpenRouter/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Account default' })).toBeInTheDocument()
  })

  it('runs against the model you picked', async () => {
    vi.mocked(listModels).mockResolvedValue([
      { id: 'dep-1', name: 'tabbyapi-production', model: 'qwen3-27b', source: 'deployment' },
    ])
    vi.mocked(startRun).mockResolvedValue(run())
    vi.mocked(getRun).mockResolvedValue(run())

    show()
    await screen.findByRole('option', { name: /tabbyapi-production/ })
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'dep-1')
    await userEvent.click(screen.getByRole('button', { name: /Run 2 cases/ }))

    await waitFor(() => expect(vi.mocked(startRun).mock.calls[0]?.[0]).toMatchObject({
      modelId: 'dep-1',
      modelLabel: 'tabbyapi-production',
    }))
  })

  it('says plainly when nothing is set up to run against', async () => {
    vi.mocked(listModels).mockResolvedValue([])
    show()

    expect(await screen.findByText(/No models are set up yet/)).toBeInTheDocument()
  })

  it('names the model a finished report was run against', async () => {
    vi.mocked(startRun).mockResolvedValue(run())
    vi.mocked(getRun).mockResolvedValue(run({ modelId: 'dep-1', modelLabel: 'tabbyapi-production' }))

    show()
    await userEvent.click(await screen.findByRole('button', { name: /Run 2 cases/ }))

    expect(await screen.findByText(/tabbyapi-production · 2\/2 cases/)).toBeInTheDocument()
  })
})
