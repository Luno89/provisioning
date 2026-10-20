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
  releaseFiles: vi.fn(),
  releaseAgain: vi.fn(),
}))
vi.mock('../../../api/project-app', async (original) => ({
  ...(await original<typeof import('../../../api/project-app')>()),
  getProjectApp: vi.fn(async () => ({ id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} })),
}))

vi.mock('../../../api/artifacts', async (original) => ({
  ...(await original<typeof import('../../../api/artifacts')>()),
  getArtifactStorage: vi.fn().mockResolvedValue({ minio: true }),
}))
const { listReleases, decideRelease, retestRelease, rollBackRelease, releaseFiles, releaseAgain } = await import('../../../api/releases')
const { artifactUrl } = await import('../../../api/artifacts')

const release = (id: string, state: OdooRelease['state'], over: Partial<OdooRelease> = {}): OdooRelease => ({
  id, projectId: 'p1', pipelineRunId: 'b', commit: `${id}c0ffee00`, image: 'i:t', state, host: 'shop.apps.local', startedAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z', ...over,
})

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ReleasesPanel projectId="p1" />
  </QueryClientProvider>,
)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(releaseFiles).mockResolvedValue({ files: [], note: 'Nothing is live yet to compare it with.' })
})

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
    await waitFor(() => expect(decideRelease).toHaveBeenCalledWith('p1', 'r2', 'cut-over', false))
  })

  it('shows what a preview would lose, and cuts it over only after a confirm that names the loss', async () => {
    vi.mocked(listReleases).mockResolvedValue({
      releases: [release('r2', 'preview', { slot: 'b', changes: {
        checkedAt: 't', tables: [], columns: [{ table: 'shop_order', column: 'note', filled: 3 }, { table: 'shop_order', column: 'unused', filled: 0 }], retyped: [],
        items: [{ kind: 'edited-view', key: 'id:7', name: 'The view Order form, edited in the app,', state: 'reset' }, { kind: 'field', key: 'x', name: 'The field Note (x_note) on sale.order, made in the app,', state: 'kept' }],
        losing: true, lost: ['the column shop_order.note is dropped; 3 rows held a value in it', 'The view Order form, edited in the app, is reset'],
      } }), release('r1', 'live', { slot: 'a' })],
      addresses: { preview: 'http://shop-preview.localhost:8000' },
    })
    vi.mocked(decideRelease).mockResolvedValue(undefined)
    show()

    expect(await screen.findByText('the column shop_order.note is dropped; 3 rows held a value in it')).toBeInTheDocument()
    expect(screen.getByText(/it drops 1 empty table or column; nothing in them is lost/)).toBeInTheDocument()
    expect(screen.getByText('Made or changed in the app: 2 things')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Cut over, losing these/ }))
    expect(screen.getByText(/Cutting over loses for good: the column shop_order.note is dropped/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Yes, cut over and lose them/ }))
    await waitFor(() => expect(decideRelease).toHaveBeenCalledWith('p1', 'r2', 'cut-over', true))
  })

  it('says when a preview was not compared with live, and when it loses nothing', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b' })], addresses: {} })
    const { unmount } = show()
    expect(await screen.findByText(/was not compared with live/)).toBeInTheDocument()
    unmount()
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b', changes: { checkedAt: 't', tables: [], columns: [], retyped: [], items: [], losing: false, lost: [] } })], addresses: {} })
    show()
    expect(await screen.findByText('Compared with live, nothing is lost.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Cut over$/ })).toBeInTheDocument()
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
    await waitFor(() => expect(decideRelease).toHaveBeenCalledWith('p1', 'r2', 'discard', false))
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

  it('tells a release built from new code from one that released an image already released', async () => {
    vi.mocked(listReleases).mockResolvedValue({
      releases: [
        release('r3', 'failed', { image: 'i:b', again: 'r2', startedAt: '2026-10-08T14:00:00Z' }),
        release('r2', 'discarded', { image: 'i:b', startedAt: '2026-10-08T13:00:00Z' }),
        release('r1', 'live', { image: 'i:a', startedAt: '2026-10-08T12:00:00Z' }),
      ],
      addresses: {},
    })
    show()
    expect(await screen.findByText('released again · r2c0ffee')).toBeInTheDocument()
    expect(screen.getAllByText('new code')).toHaveLength(2)
  })

  it('shows the files a preview changes since live, the app\'s apart from the rest, each with its diff', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b' }), release('r1', 'live', { slot: 'a' })], addresses: {} })
    vi.mocked(releaseFiles).mockResolvedValue({
      against: { releaseId: 'r1', commit: 'aaaaaaaaaa', state: 'live' },
      files: [
        { path: 'addons/labels/report.xml', status: 'modified', added: 2, removed: 1, binary: false, patch: 'diff --git a/addons/labels/report.xml b/addons/labels/report.xml\n@@ -1 +1,2 @@\n-old\n+new\n+more', inApp: true },
        { path: 'PLAN.md', status: 'modified', added: 1, removed: 0, binary: false, patch: 'diff --git a/PLAN.md b/PLAN.md\n+x', inApp: false },
      ],
    })
    show()
    expect(await screen.findByText(/since aaaaaaaa \(live now\)/)).toBeInTheDocument()
    expect(releaseFiles).toHaveBeenCalledWith('p1', 'r2')
    expect(screen.getByText('In the app')).toBeInTheDocument()
    expect(screen.getByText('Elsewhere in the repository')).toBeInTheDocument()
    expect(screen.queryByTestId('release-file-patch')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('addons/labels/report.xml'))
    expect(screen.getByTestId('release-file-patch').textContent).toContain('+more')
  })

  it('releases a discarded build again after a confirm that says the waiting preview is set aside', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b' }), release('r1', 'discarded')], addresses: {} })
    vi.mocked(releaseAgain).mockResolvedValue(undefined)
    show()
    const buttons = await screen.findAllByRole('button', { name: /Release this build again/ })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    expect(screen.getByText(/The preview waiting now is set aside/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Yes, release it again/ }))
    await waitFor(() => expect(releaseAgain).toHaveBeenCalledWith('p1', 'r1'))
  })

  it('offers no release again for the live release', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r1', 'live')], addresses: {} })
    show()
    expect(await screen.findByText('live')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Release this build again/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Files changed/ }))
    expect(await screen.findByText('Nothing is live yet to compare it with.')).toBeInTheDocument()
  })
})
