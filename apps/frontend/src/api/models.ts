import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { useDebounce } from '../lib/use-debounce'

export interface HfModelSize {
  totalBytes: number
  fileCount: number
  kvCacheBytesPerGpu?: number | undefined
  weightBytesPerGpu?: number | undefined
}

export interface ModelSearchResult {
  id: string
  downloads: number
  likes?: number
}

export const modelKeys = {
  tags: (repo: string) => ['tags', repo] as const,
  localTags: (repo: string) => ['local-tags', repo] as const,
  hfSize: (params: Record<string, unknown>) => ['hf-size', params] as const,
  search: (appType: string, q: string) => ['model-search', appType, q] as const,
}

export function useImageTags(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: modelKeys.tags(repo),
    queryFn: () => api.get<string[]>('/registry/tags', { params: { repo } }).then((r) => r.data),
    enabled: enabled && !!repo,
  })
}

export function useHfModelSize(
  params: { repo: string; revision?: string; maxSeqLen?: string; cacheMode?: string; gpuCount?: string },
  enabled: boolean,
) {
  return useQuery({
    queryKey: modelKeys.hfSize(params),
    queryFn: () => api.get<HfModelSize>('/models/hf-size', {
      params: {
        repo: params.repo,
        revision: params.revision || undefined,
        maxSeqLen: params.maxSeqLen || undefined,
        cacheMode: params.cacheMode,
        gpuCount: params.gpuCount,
      },
    }).then((r) => r.data),
    enabled: enabled && !!params.repo,
    retry: false,
  })
}

export function useModelSearch(appType: string, query: string, enabled: boolean) {
  const debounced = useDebounce(query, 400)
  return useQuery({
    queryKey: modelKeys.search(appType, debounced),
    queryFn: () => api.get<ModelSearchResult[]>('/models/search', {
      params: { q: debounced, appType },
    }).then((r) => r.data),
    enabled,
  })
}

export const TABBY_IMAGE_REPO = 'ghcr.io/theroyallab/tabbyapi';

const TABBY_IMAGE_TAG_HINTS: Record<string, string> = {
  latest: 'CUDA 12.8',
  cu13: 'CUDA 13.x',
};

export interface TabbyImageTag {
  tag: string
  cached: boolean
  label: string
}

export function useTabbyImageTags(enabled: boolean) {
  const remote = useQuery({
    queryKey: modelKeys.tags(TABBY_IMAGE_REPO),
    queryFn: () => api.get<string[]>('/registry/tags', { params: { repo: TABBY_IMAGE_REPO } }).then((r) => r.data),
    enabled,
  })
  const local = useQuery({
    queryKey: modelKeys.localTags(TABBY_IMAGE_REPO),
    queryFn: () => api.get<string[]>('/registry/local-tags', { params: { repo: TABBY_IMAGE_REPO } }).then((r) => r.data),
    enabled,
  })

  const options: TabbyImageTag[] = Array.from(new Set([...(remote.data ?? []), ...(local.data ?? [])]))
    .map((tag) => ({
      tag,
      cached: (local.data ?? []).includes(tag),
      label: TABBY_IMAGE_TAG_HINTS[tag] ? `${tag} — ${TABBY_IMAGE_TAG_HINTS[tag]}` : tag,
    }))

  return { options, loading: remote.isLoading }
}

export function useHfBranches(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ['hf-branches', repo] as const,
    queryFn: () => api.get<string[]>('/models/hf-branches', { params: { repo } }).then((r) => r.data),
    enabled: enabled && !!repo,
    staleTime: 30_000,
  })
}

export interface ModelProvider {
  id: string
  name: string
  source: 'deployment' | 'endpoint'
  kind?: 'vllm' | 'tabbyapi'
  model: string
  baseUrl?: string
  isMesh?: boolean
  hasApiKey?: boolean
  gpuCount?: number
}

export const providerKeys = {
  list: () => ['models'] as const,
}

export const listModels = (): Promise<ModelProvider[]> =>
  api.get<ModelProvider[]>('/models').then((r) => r.data)

export const addModelEndpoint = (form: {
  name: string; baseUrl: string; model: string; apiKey?: string
}): Promise<ModelProvider> =>
  api.post<ModelProvider>('/model-endpoints', form).then((r) => r.data)

export const removeModelEndpoint = (id: string): Promise<void> =>
  api.delete(`/model-endpoints/${id}`).then(() => undefined)
