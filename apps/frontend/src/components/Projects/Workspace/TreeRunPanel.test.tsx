import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TreeRunPanel } from './TreeRunPanel.js'
import * as groveApi from '../../../api/grove.js'

vi.mock('../../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  getTreeRun: vi.fn(),
  runTree: vi.fn(),
  stopTreeRun: vi.fn(),
}))

const renderPanel = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TreeRunPanel treeId="t1" />
  </QueryClientProvider>,
)

describe('TreeRunPanel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('runs a tree that has not run, and shows it running', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'none' })
    vi.mocked(groveApi.runTree).mockResolvedValue({ state: 'running', startedAt: '2026-09-25T10:00:00.000Z' })
    renderPanel()

    fireEvent.click(await screen.findByText('Run the tree'))
    await waitFor(() => expect(groveApi.runTree).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText(/Running since/)).toBeTruthy()
    expect(screen.queryByText('Run the tree')).toBeNull()
  })

  it('says how the last run ended and what waits for review', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({
      state: 'finished', startedAt: 'then', result: { outcome: 'quiet', awaitingReview: ['l2'] },
    })
    renderPanel()
    expect(await screen.findByText('The last run finished: nothing left to work. 1 claim waits for your review.')).toBeTruthy()
    expect(screen.getByText('Run it again')).toBeTruthy()
  })

  it('says what a failed run died of, rather than only that it failed', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({
      state: 'failed', startedAt: 'then', closedAt: 'later',
      reason: 'The workspace image did not build: No match for argument: jq-nonexistent',
    })
    renderPanel()

    expect(await screen.findByText(
      'The last run stopped: The workspace image did not build: No match for argument: jq-nonexistent.',
    )).toBeTruthy()
    expect(screen.getByText('Run it again')).toBeTruthy()
  })

  it('stops a running tree, and says the stopped leaves are back to waiting', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValueOnce({ state: 'running', startedAt: '2026-09-25T10:00:00.000Z' })
    vi.mocked(groveApi.stopTreeRun).mockResolvedValue({ state: 'running', startedAt: '2026-09-25T10:00:00.000Z' })
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({
      state: 'finished', startedAt: 'then',
      result: { treeId: 't1', outcome: 'stopped', awaitingReview: [] },
    } as never)
    renderPanel()

    fireEvent.click(await screen.findByText('Stop the run'))
    await waitFor(() => expect(groveApi.stopTreeRun).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText(/You stopped the last run; the leaves it was working are back to waiting/)).toBeTruthy()
    expect(screen.getByText('Run it again')).toBeTruthy()
  })
})
