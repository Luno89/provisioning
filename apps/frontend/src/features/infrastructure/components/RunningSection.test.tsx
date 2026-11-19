import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import RunningSection from './RunningSection'
import * as runningApi from '../api/running'

vi.mock('../api/running', async (orig) => ({
  ...(await orig<typeof runningApi>()),
  getRunning: vi.fn(),
  cancelRunning: vi.fn(async () => undefined),
  pauseBench: vi.fn(async (paused: boolean) => ({ paused })),
  pauseKeeper: vi.fn(async (paused: boolean) => ({ paused, held: 0 })),
}))

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RunningSection />
  </QueryClientProvider>,
)

const refused = (error: string) => Object.assign(new Error('Request failed with status code 503'), { response: { status: 503, data: { error } } })

const since = new Date(Date.now() - 5 * 60_000).toISOString()

describe('the Running section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runningApi.getRunning).mockResolvedValue({
      items: [
        { workflowId: 'check-run-b1', kind: 'bench', title: 'The bench, checking Koala: 14 of 22 checks', since, opens: { kind: 'checks', id: 'b1' }, cancel: { via: 'check' } },
        { workflowId: 'run-r1', kind: 'chat', title: 'Koala answering in "Labels"', since, opens: { kind: 'chat', id: 'c1' }, cancel: { via: 'run' }, asking: ['call-1'] },
        { workflowId: 'remove-project-p1', kind: 'removal', title: 'Deleting the project Shop', since, opens: { kind: 'temporal' }, cancel: { via: 'none', why: 'deleting cannot be stopped part way' } },
      ],
      bench: { paused: false },
      keeper: { paused: true, held: 2 },
    })
  })

  it('lists what runs with where it opens, what it waits on, and cancels one only after a confirm', async () => {
    show()
    expect(await screen.findByRole('link', { name: 'The bench, checking Koala: 14 of 22 checks' })).toHaveAttribute('href', '#/evals')
    expect(screen.getByRole('link', { name: 'Koala answering in "Labels"' })).toHaveAttribute('href', '#/chat/c1')
    expect(screen.getByText(/waits for you to allow a call/)).toBeInTheDocument()
    expect(screen.getByText('It cannot be cancelled: deleting cannot be stopped part way.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Cancel/ })).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: /Cancel/ })[0]!)
    expect(runningApi.cancelRunning).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    await waitFor(() => expect(runningApi.cancelRunning).toHaveBeenCalledWith('check-run-b1'))
  })

  it('pauses the bench, resumes the memory keeper, and says what the keeper holds', async () => {
    show()
    expect(await screen.findByText('The bench: running')).toBeInTheDocument()
    expect(screen.getByText('The memory keeper: paused')).toBeInTheDocument()
    expect(screen.getByText(/2 are held now/)).toBeInTheDocument()
    expect(screen.getByText(/A bench run is going now; cancel it above to stop it too/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(runningApi.pauseBench).toHaveBeenCalledWith(true, expect.anything()))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(runningApi.pauseKeeper).toHaveBeenCalledWith(false, expect.anything()))
  })

  it('says why what runs could not be read, rather than that nothing runs', async () => {
    vi.mocked(runningApi.getRunning).mockRejectedValue(refused('Temporal is not answering since 09:14: connection refused'))
    show()
    expect(await screen.findByText('Temporal is not answering since 09:14: connection refused')).toBeInTheDocument()
    expect(screen.queryByText('Nothing is running.')).toBeNull()
  })

  it('says why a run could not be cancelled', async () => {
    vi.mocked(runningApi.cancelRunning).mockRejectedValueOnce(refused('it is not yours to cancel'))
    show()
    fireEvent.click((await screen.findAllByRole('button', { name: /Cancel/ }))[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    expect(await screen.findByText('it is not yours to cancel')).toBeInTheDocument()
    expect(screen.queryByText(/Cancelling — it runs its own ending/)).toBeNull()
  })

  it('says why the bench or the memory keeper could not be paused or resumed', async () => {
    vi.mocked(runningApi.pauseBench).mockRejectedValueOnce(refused('the bench schedule could not be saved: the database is not answering'))
    vi.mocked(runningApi.pauseKeeper).mockRejectedValueOnce(refused('the memory keeper did not answer'))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByText('the bench schedule could not be saved: the database is not answering')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(await screen.findByText('the memory keeper did not answer')).toBeInTheDocument()
  })

  it('says when nothing runs', async () => {
    vi.mocked(runningApi.getRunning).mockResolvedValue({ items: [], bench: { paused: false }, keeper: { paused: false, held: 0 } })
    show()
    expect(await screen.findByText('Nothing is running.')).toBeInTheDocument()
  })
})
