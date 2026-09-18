import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ComparePanel from './ComparePanel'
import type { Level1Run } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, listLevel1Runs: vi.fn(), compareLevel1Runs: vi.fn() }
})

const { listLevel1Runs, compareLevel1Runs } = await import('../../api/evals')

const run = (id: string, over: Partial<Level1Run> = {}): Level1Run => ({
  id,
  state: 'done',
  startedAt: '2026-09-17T09:00:00.000Z',
  repeats: 3,
  toolCatalogueHash: 'hash',
  cases: ['read/by-name'],
  finished: 1,
  results: [],
  summary: { reliability: { cases: 1, always: 1, never: 0, flaky: 0 }, tools: [] },
  ...over,
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ComparePanel />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('comparing two level 1 runs', () => {
  it('says there is nothing to compare until two runs have finished', async () => {
    vi.mocked(listLevel1Runs).mockResolvedValue([run('run-1')])
    show()

    expect(await screen.findByText(/two finished runs/)).toBeInTheDocument()
    expect(compareLevel1Runs).not.toHaveBeenCalled()
  })

  it('compares the two most recent finished runs and shows what moved', async () => {
    vi.mocked(listLevel1Runs).mockResolvedValue([
      run('after', { modelLabel: 'Tabbyapi-Production' }),
      run('before', { modelLabel: 'Some other model' }),
    ])
    vi.mocked(compareLevel1Runs).mockResolvedValue({
      before: 'before',
      after: 'after',
      differences: [{ what: 'model', before: 'Some other model', after: 'Tabbyapi-Production' }],
      cases: [{ name: 'read/by-name', before: { passed: 1, attempts: 3 }, after: { passed: 3, attempts: 3 }, change: 0.6667 }],
      tools: [{ tool: 'read_procedure', before: { passed: 1, attempts: 3 }, after: { passed: 3, attempts: 3 }, change: 0.6667 }],
    })
    show()

    await waitFor(() => expect(compareLevel1Runs).toHaveBeenCalledWith('before', 'after'))

    expect(await screen.findByText('Tabbyapi-Production')).toBeInTheDocument()
    expect(screen.getAllByText('+67%')).toHaveLength(2)
    expect(screen.getAllByText('1/3 → 3/3')).toHaveLength(2)
  })

  it('leaves a run that is still going out of the pickers', async () => {
    vi.mocked(listLevel1Runs).mockResolvedValue([run('running-one', { state: 'running' }), run('done-one')])
    show()

    await screen.findByText(/two finished runs/)
    expect(compareLevel1Runs).not.toHaveBeenCalled()
  })
})
