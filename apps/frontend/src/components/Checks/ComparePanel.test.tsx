import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ComparePanel from './ComparePanel'
import type { Level2Run, Scenario, ScenarioResult } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, listLevel2Runs: vi.fn(), listScenarios: vi.fn(), compareCheckRuns: vi.fn() }
})

const { listLevel2Runs, listScenarios, compareCheckRuns } = await import('../../api/evals')

const check = (id: string, agent: string): Scenario => ({ id, name: id, describe: '', agent, procedure: { id: 'turn-check' }, input: { message: 'go' }, turn: true, expect: { chooses: { tool: 'read_procedure' } } })
const result = (scenarioId: string) => ({ scenarioId, name: scenarioId, passed: true } as ScenarioResult)
const run = (id: string, over: Partial<Level2Run> = {}): Level2Run => ({
  id, state: 'done', startedAt: '2026-10-08T09:00:00.000Z', scenarios: ['turn-reads'], finished: 1, results: [result('turn-reads')], ...over,
})

const show = (scope?: { agent: string }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ComparePanel scope={scope} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listScenarios).mockResolvedValue([check('turn-reads', 'agent-builder'), check('turn-claims', 'executor')])
})

describe('comparing two check runs', () => {
  it('says there is nothing to compare until two runs have finished', async () => {
    vi.mocked(listLevel2Runs).mockResolvedValue([run('run-1')])
    show()

    expect(await screen.findByText(/two finished runs/)).toBeInTheDocument()
    expect(compareCheckRuns).not.toHaveBeenCalled()
  })

  it('compares the two most recent finished runs and shows what moved, counting repeats', async () => {
    vi.mocked(listLevel2Runs).mockResolvedValue([run('after', { modelLabel: 'Tabbyapi-Production' }), run('before', { modelLabel: 'Some other model' })])
    vi.mocked(compareCheckRuns).mockResolvedValue({
      before: 'before',
      after: 'after',
      differences: [{ what: 'model', before: 'Some other model', after: 'Tabbyapi-Production' }],
      checks: [{ id: 'turn-reads', name: 'agent-builder: read by name', before: { passed: 1, attempts: 3 }, after: { passed: 3, attempts: 3 }, change: 0.6667 }],
      tools: [{ tool: 'read_procedure', before: { passed: 1, attempts: 3 }, after: { passed: 3, attempts: 3 }, change: 0.6667 }],
    })
    show()

    await waitFor(() => expect(compareCheckRuns).toHaveBeenCalledWith('before', 'after'))
    expect((await screen.findAllByText('Tabbyapi-Production')).length).toBeGreaterThan(0)
    expect(screen.getByText('agent-builder: read by name')).toBeInTheDocument()
    expect(screen.getAllByText('+67%')).toHaveLength(2)
    expect(screen.getAllByText('1/3 → 3/3')).toHaveLength(2)
  })

  it('offers only finished runs that include a check of the page it is on', async () => {
    vi.mocked(listLevel2Runs).mockResolvedValue([
      run('running-one', { state: 'running' }),
      run('builder-only'),
      run('executor-one', { scenarios: ['turn-claims'], results: [result('turn-claims')] }),
    ])
    show({ agent: 'executor' })

    await screen.findByText(/two finished runs/)
    expect(compareCheckRuns).not.toHaveBeenCalled()
  })
})
