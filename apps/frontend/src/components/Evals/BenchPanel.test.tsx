import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BenchPanel from './BenchPanel'
import type { Level2Run, Scenario } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, getBench: vi.fn(), saveBench: vi.fn() }
})

const { getBench, saveBench } = await import('../../api/evals')

const scenario: Scenario = { id: 'koala-cluster', name: 'Koala lists clusters', describe: '', agent: 'koala', procedure: { id: 'interactive-chat' }, input: { message: 'x' }, expect: {} } as Scenario
const run = (id: string, startedAt: string, passed: boolean, over: Partial<Level2Run> = {}): Level2Run => ({
  id, state: 'done', startedAt, scenarios: ['koala-cluster'], finished: 1,
  results: [{ scenarioId: 'koala-cluster', passed } as Level2Run['results'][number]], ...over,
})

const show = (runs: Level2Run[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><BenchPanel scenarios={[scenario]} runs={runs} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getBench).mockResolvedValue({ settings: { enabled: true, idleMinutes: 15, fullEveryHours: 24 }, state: { benched: {}, lastFullAt: '2026-10-03T08:00:00Z' } })
})

describe('the bench', () => {
  it('shows each scenario\'s results run by run, newest first, and marks a regression', async () => {
    show([
      run('new', '2026-10-03T12:00:00Z', false, { regressions: ['koala-cluster'], trigger: { kind: 'changed', agents: ['koala'] } }),
      run('old', '2026-10-02T12:00:00Z', true, { trigger: { kind: 'full' } }),
    ])

    const cells = await screen.findAllByRole('cell', { name: /Koala lists clusters, / })
    expect(cells.map((cell) => cell.getAttribute('aria-label')?.split(': ')[1])).toEqual(['regressed', 'passed'])
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('title', expect.stringContaining('bench, changed koala'))
  })

  it('saves its settings', async () => {
    vi.mocked(saveBench).mockResolvedValue({ enabled: true, idleMinutes: 30, fullEveryHours: 24 })
    show([])

    const minutes = await screen.findByRole('spinbutton', { name: 'Idle minutes before the bench runs' })
    await userEvent.clear(minutes)
    await userEvent.type(minutes, '30')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveBench).toHaveBeenCalledWith({ enabled: true, idleMinutes: 30, fullEveryHours: 24 }))
  })
})
