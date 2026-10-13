import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as groveApi from '../../../api/grove'
import * as turnsApi from '../../../api/turns'
import { StoryFeed } from './StoryFeed'

vi.mock('../../../api/grove', async (orig) => ({ ...(await orig<typeof groveApi>()), getTreeRun: vi.fn() }))
vi.mock('../../../api/turns', async (orig) => ({ ...(await orig<typeof turnsApi>()), readRunsUnder: vi.fn() }))
vi.mock('./StoryRun', () => ({ default: ({ run, events }: { run: { runId: string; thinking: string }; events: { type: string }[] }) => <div data-testid="run">{`${run.runId}: ${run.thinking} (${events.length} events)`}</div> }))

const renderFeed = (leaf: Parameters<typeof StoryFeed>[0]['leaf']) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StoryFeed treeId="t1" leaf={leaf} /></QueryClientProvider>,
)

describe('watching a story being worked', () => {
  it('is closed until asked, then shows its worker\'s run and the runs it started, from the tree\'s turn', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'running', startedAt: 't', turnId: 'grove-run-t1' })
    vi.mocked(turnsApi.readRunsUnder).mockResolvedValueOnce({ through: 1, entries: [{ turnId: 'grove-run-t1', seq: 1, at: 't', events: [
      { type: 'run.started', runId: 'leaf-run', at: 't', agentId: 'leaf-worker', loopId: 'l', parentRunId: 'grove-run-t1' },
      { type: 'run.started', runId: 'task-run', at: 't', agentId: 'executor', loopId: 'l', parentRunId: 'leaf-run' },
      { type: 'thinking', runId: 'task-run', at: 't', nodeId: 'model', delta: 'reading the form view' },
      { type: 'run.started', runId: 'other-leaf', at: 't', agentId: 'leaf-worker', loopId: 'l', parentRunId: 'grove-run-t1' },
    ] }] }).mockResolvedValue({ entries: [], through: 1 })
    renderFeed({ id: 'l1', status: 'running', runId: 'leaf-run', updatedAt: 't' })

    const toggle = await screen.findByRole('button', { name: 'Watch it work' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('run')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect((await screen.findAllByTestId('run')).map((run) => run.textContent)).toEqual(['task-run: reading the form view (2 events)'])
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['leaf-worker', 'executor'])
    fireEvent.click(screen.getByRole('tab', { name: 'leaf-worker' }))
    expect(screen.getByTestId('run').textContent).toBe('leaf-run:  (1 events)')
    expect(screen.queryByText(/other-leaf/)).not.toBeInTheDocument()
    expect(turnsApi.readRunsUnder).toHaveBeenCalledWith('grove-run-t1', 0, 'leaf-run')
  })

  it('says it is reading its run while the log is read, and only then that nothing has come in', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'running', startedAt: 't', turnId: 'grove-run-t1' })
    let answer = (_: { entries: never[]; through: number }) => {}
    vi.mocked(turnsApi.readRunsUnder).mockReset().mockImplementationOnce(() => new Promise((resolve) => { answer = resolve })).mockResolvedValue({ entries: [], through: 5 })
    renderFeed({ id: 'l1', status: 'running', runId: 'leaf-run', updatedAt: 't' })
    fireEvent.click(await screen.findByRole('button', { name: 'Watch it work' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Reading its run/)
    expect(screen.queryByText('Nothing from its run has come in yet.')).not.toBeInTheDocument()
    answer({ entries: [], through: 5 })
    expect(await screen.findByText('Nothing from its run has come in yet.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers how a finished story was worked, and nothing for one never worked', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'failed', startedAt: 't', reason: 'r', turnId: 'grove-run-t1' })
    renderFeed({ id: 'l1', status: 'succeeded', runId: 'leaf-run', updatedAt: 't' })
    expect(await screen.findByRole('button', { name: 'See how it was worked' })).toBeInTheDocument()
  })

  it('offers nothing for a story never worked', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'none' })
    const { container } = renderFeed({ id: 'l1', status: 'pending', updatedAt: 't' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container).toBeEmptyDOMElement()
  })
})
