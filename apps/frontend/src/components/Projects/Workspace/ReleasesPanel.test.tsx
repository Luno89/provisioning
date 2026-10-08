import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleasesPanel } from './ReleasesPanel'
import type { OdooRelease } from '../../../api/releases'

vi.mock('../../../api/releases', async (original) => ({
  ...(await original<typeof import('../../../api/releases')>()),
  listReleases: vi.fn(),
  decideRelease: vi.fn(),
}))
const { listReleases, decideRelease } = await import('../../../api/releases')

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

  it('discards a waiting release, and says how to open a preview that is not exposed', async () => {
    vi.mocked(listReleases).mockResolvedValue({ releases: [release('r2', 'preview', { slot: 'b' })], addresses: {} })
    vi.mocked(decideRelease).mockResolvedValue(undefined)
    show()

    expect(await screen.findByText(/Expose the app under Applications/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }))
    await waitFor(() => expect(decideRelease).toHaveBeenCalledWith('p1', 'r2', 'discard'))
  })
})
