import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DependenciesSection } from './DependenciesSection'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), post: vi.fn() } }
})

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><DependenciesSection /></QueryClientProvider>)
}

describe('Koala\'s dependencies, for root\'s operator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({ data: {
      check: {
        checkedAt: '2026-11-13T12:00:00Z',
        releases: [{ release: 'bbbbbbbbbbbb', label: 'v2026.11.13', instances: [], root: true, components: 2, inventory: true }],
        components: [],
        builds: [{ image: 'theroyallab/tabbyapi', tag: 'latest', pinned: 'a'.repeat(64), digest: 'b'.repeat(64), builtAt: '2026-11-12T20:00:00Z', revision: 'c0ffee1234', firstSeenAt: '2026-11-13T12:00:00.000Z', takeOn: '2099-11-27' }],
        gone: [{ image: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', digest: 'd'.repeat(64), since: '2026-11-14T06:00:00.000Z', releases: ['v2026.11.13'] }],
        problems: [],
      },
      findings: [],
    } })
  })

  it('lists a newer build of a moving tag with when it can be taken', async () => {
    renderSection()
    expect(await screen.findByRole('list', { name: 'Newer builds of a moving tag' })).toHaveTextContent('theroyallab/tabbyapi:latest now names sha256:bbbbbbbbbbbb, built 2026-11-12 from c0ffee1, first seen 2026-11-13. It can be taken on 2099-11-27.')
  })

  it('names a pinned digest its registry no longer has, and since when', async () => {
    renderSection()
    expect(await screen.findByRole('list', { name: 'Pinned images gone upstream' })).toHaveTextContent('vllm/vllm-openai@sha256:dddddddddddd is gone upstream since 2026-11-14: docker.io no longer has the digest v2026.11.13 pins, so a machine that has not pulled it already cannot deploy it.')
  })
})
