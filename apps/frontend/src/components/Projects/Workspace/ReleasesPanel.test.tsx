import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleasesPanel } from './ReleasesPanel'
import type { OdooRelease } from '../../../api/releases'

vi.mock('../../../api/releases', async (original) => ({
  ...(await original<typeof import('../../../api/releases')>()),
  listReleases: vi.fn(),
  decideRelease: vi.fn(),
  retestRelease: vi.fn(),
  rollBackRelease: vi.fn(),
}))
vi.mock('../../../api/project-app', async (original) => ({
  ...(await original<typeof import('../../../api/project-app')>()),
  getProjectApp: vi.fn(async () => ({ id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} })),
}))

vi.mock('../../../api/artifacts', async (original) => ({
  ...(await original<typeof import('../../../api/artifacts')>()),
  getArtifactStorage: vi.fn().mockResolvedValue({ minio: true }),
}))
const { listReleases, decideRelease, retestRelease, rollBackRelease } = await import('../../../api/releases')
const { artifactUrl } = await import('../../../api/artifacts')

const release = (id: string, state: OdooRelease['state'], over: Partial<OdooRelease> = {}): OdooRelease => ({
  id, projectId: 'p1', pipelineRunId: 'b', commit: `${id}c0ffee00`, image: 'i:t', state, host: 'shop.apps.local', startedAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z', ...over,
})

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ReleasesPanel projectId="p1" />
  </QueryClientProvider>,
)

beforeEach(() => vi.clearAllMocks())

describe('a project\'s releases', () => {
  it('shows nothing for a project that releases no other way than before', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [], addresses: {} })
    const { container } = show()
    await waitFor(() => expect(listReleases).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('lists each release, and offers the waiting one\'s preview, cut over after a confirm, and discard', async () => {
    vi.mocked(listReleases).mockResolvedValue({
      releases: [release('r2', 'preview', { slot: 'b' }), release('r1', 'live', { slot: 'a' }), release('r0', 'failed', { reason: 'shop-upgrade-b failed: Failed to load registry' })],
      addresses: { live: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' },
    })
    vi.mocked(decideRelease).mockResolvedValue(undefined)
    show()

    expect(await screen.findByText('ready to preview')).toBeInTheDocument()
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.getByText(/Failed to load registry/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open preview/ })).toHaveAttribute('href', 'http://shop-preview.localhost:8000')
    expect(screen.getByRole('link', { name: /Open live/ })).toHaveAttribute('href', 'http://shop.localhost:8000')

    fireEvent.click(screen.getByRole('button', { name: /^Cut over$/ }))
    expect(decideRelease).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Yes, cut over/ }))
    await waitFor(() => expect(decideRelease).toHaveBeenCalledWith('p1', 'r2', 'cut-over'))
  })

  it('offers to roll the live release back after a confirm that says what is lost, and only when one is kept', async () => {
    vi.mocked(listReleases).mockResolvedValue({
      releases: [release('r2', 'live', { slot: 'b' }), release('r1', 'superseded', { slot: 'a', reason: 'replaced by the release of r2c0ffee' })],
      addresses: {},
      rollBack: { from: 'r2', to: 'r1', commit: 'r1c0ffee00', liveSince: new Date(Date.now() - 12 * 60_000).toISOString() },
    })
    vi.mocked(rollBackRelease).mockResolvedValue(undefined)
    show()

    fireEvent.click(await screen.findByRole('button', { name: /Roll back to r1c0ffee/ }))
    expect(screen.getByText(/exactly as it was at the cutover 12m ago\. Anything entered in the app since then is lost/)).toBeInTheDocument()
    expect(rollBackRelease).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Yes, roll back/ }))
    await waitFor(() => expect(rollBackRelease).toHaveBeenCalledWith('p1', 'r2'))
  })

  it('offers no rollback when nothing is kept to go back to', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'live', { slot: 'b' }), release('r1', 'rolled-back', { reason: 'rolled back to the release of r0c0ffee' })], addresses: {} })
    show()
    expect(await screen.findByText('rolled back')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Roll back/ })).not.toBeInTheDocument()
  })

  it('discards a waiting release, and offers to expose and open a preview that is not exposed', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b' })], addresses: {} })
    vi.mocked(decideRelease).mockResolvedValue(undefined)
    show()

    expect(await screen.findByRole('button', { name: /open preview/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }))
    await waitFor(() => expect(decideRelease).toHaveBeenCalledWith('p1', 'r2', 'discard'))
  })

  it('shows the preview\'s browser tests on its card: each failure with why, what the browser saw, and a way to run them again', async () => {
    vi.mocked(listReleases).mockResolvedValue({
      releases: [release('r2', 'preview', { slot: 'b', e2e: {
        state: 'failed',
        summary: '1 passed, 1 failed',
        tests: [
          { title: 'a person signs in', file: 'signs-in.spec.ts', status: 'passed', durationMs: 900 },
          { title: 'a person sees the note on the order', file: 'note.spec.ts', status: 'failed', durationMs: 60000, error: 'expect(locator).toBeVisible() failed' },
        ],
        artifacts: [{ id: 'a1', name: 'note/test-failed-1.png' }, { id: 'a2', name: 'note/trace.zip' }],
        startedAt: 't0',
        finishedAt: 't1',
      } })],
      addresses: {},
    })
    vi.mocked(retestRelease).mockResolvedValue(undefined)
    show()

    expect(await screen.findByText(/Browser tests failed/)).toBeInTheDocument()
    expect(screen.getByText('1 passed, 1 failed')).toBeInTheDocument()
    expect(screen.getByText(/a person sees the note on the order/)).toBeInTheDocument()
    expect(screen.getByText('expect(locator).toBeVisible() failed')).toBeInTheDocument()
    expect(screen.getByText(/Advice only/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'note/test-failed-1.png' })).toHaveAttribute('src', artifactUrl('a1'))
    expect(screen.getByRole('link', { name: 'note/trace.zip' })).toHaveAttribute('href', artifactUrl('a2'))
    expect(screen.getByRole('button', { name: /Cut over/ })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run again/ }))
    await waitFor(() => expect(retestRelease).toHaveBeenCalledWith('p1', 'r2'))
  })

  it('says the tests are running, offering no second run until they finish', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b', e2e: { state: 'running', startedAt: 't0' } })], addresses: {} })
    show()
    expect(await screen.findByText(/Browser tests running against the preview/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Run again/ })).toBeNull()
  })
})
