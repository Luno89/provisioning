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

  it('runs an engine tree that has not run, and shows it running', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'none', engine: true })
    vi.mocked(groveApi.runTree).mockResolvedValue({ state: 'running', engine: true, startedAt: '2026-09-25T10:00:00.000Z' })
    renderPanel()

    fireEvent.click(await screen.findByText('Run the tree'))
    await waitFor(() => expect(groveApi.runTree).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText(/Running since/)).toBeTruthy()
    expect(screen.queryByText('Run the tree')).toBeNull()
  })

  it('says how the last run ended and what waits for review', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({
      state: 'finished', engine: true, startedAt: 'then', result: { outcome: 'quiet', passes: 2, awaitingReview: ['l2'] },
    })
    renderPanel()
    expect(await screen.findByText('The last run finished after 2 passes: nothing left to work. 1 claim waits for your review.')).toBeTruthy()
    expect(screen.getByText('Run it again')).toBeTruthy()
  })

  it('shows nothing for a tree that runs on the legacy pipeline', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'none', engine: false })
    const { container } = renderPanel()
    await waitFor(() => expect(groveApi.getTreeRun).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="tree-run"]')).toBeNull()
  })

  it('stops a running tree, and says the stopped leaves are back to waiting', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValueOnce({ state: 'running', engine: true, startedAt: '2026-09-25T10:00:00.000Z' })
    vi.mocked(groveApi.stopTreeRun).mockResolvedValue({ state: 'running', engine: true, startedAt: '2026-09-25T10:00:00.000Z' })
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({
      state: 'finished', engine: true, startedAt: 'then',
      result: { treeId: 't1', outcome: 'stopped', passes: 1, awaitingReview: [] },
    } as never)
    renderPanel()

    fireEvent.click(await screen.findByText('Stop the run'))
    await waitFor(() => expect(groveApi.stopTreeRun).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText(/You stopped the last run after 1 pass; the leaves it was working are back to waiting/)).toBeTruthy()
    expect(screen.getByText('Run it again')).toBeTruthy()
  })
})
