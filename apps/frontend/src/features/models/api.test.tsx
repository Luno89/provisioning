import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const asked = vi.hoisted(() => [] as { path: string; params: unknown }[])

vi.mock('../../api/client', () => ({
  api: {
    get: async (path: string, config: { params: unknown }) => {
      asked.push({ path, params: config.params })
      const data = path === '/registry/tags'
        ? { tags: [], page: 1, pageSize: 30, total: 0, totalPages: 1, sort: 'newest' }
        : path === '/models/hf-size' ? { bytes: 1 } : []
      return { data }
    },
  },
  errorMessage: (err: unknown) => String(err),
}))

const { useHfBranches, useHfModelSize, useImageTags, useTabbyImageTags, TABBY_IMAGE_REPO } = await import('./api')

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

const askedFor = async (count: number) => { await waitFor(() => { expect(asked).toHaveLength(count) }) }

describe('what the model wizard asks the backend', () => {
  afterEach(() => { asked.length = 0 })

  it('asks for an image\'s tags by repository, page, size and order', async () => {
    renderHook(() => useImageTags('vllm/vllm-openai', true, { page: 2, pageSize: 30, sort: 'newest' }), { wrapper })
    await askedFor(1)
    expect(asked[0]).toEqual({ path: '/registry/tags', params: { repo: 'vllm/vllm-openai', page: 2, pageSize: 30, sort: 'newest' } })
  })

  it('asks for a model\'s size and leaves out the revision and length the person left empty', async () => {
    renderHook(() => useHfModelSize({ repo: 'Qwen/Qwen2.5-0.5B-Instruct', revision: '', maxSeqLen: '', cacheMode: 'FP16', gpuCount: '1' }, true), { wrapper })
    await askedFor(1)
    expect(asked[0]).toEqual({ path: '/models/hf-size', params: { repo: 'Qwen/Qwen2.5-0.5B-Instruct', revision: undefined, maxSeqLen: undefined, cacheMode: 'FP16', gpuCount: '1' } })
  })

  it('asks for TabbyAPI\'s published tags and the ones this machine holds', async () => {
    renderHook(() => useTabbyImageTags(true), { wrapper })
    await askedFor(2)
    expect(asked).toEqual(expect.arrayContaining([
      { path: '/registry/tags', params: { repo: TABBY_IMAGE_REPO, pageSize: 100 } },
      { path: '/registry/local-tags', params: { repo: TABBY_IMAGE_REPO } },
    ]))
  })

  it('asks for a model\'s branches by repository', async () => {
    renderHook(() => useHfBranches('Qwen/Qwen2.5-0.5B-Instruct', true), { wrapper })
    await askedFor(1)
    expect(asked[0]).toEqual({ path: '/models/hf-branches', params: { repo: 'Qwen/Qwen2.5-0.5B-Instruct' } })
  })
})
