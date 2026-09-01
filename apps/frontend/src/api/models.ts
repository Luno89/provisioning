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
  tags: (repo: string, query: TagQuery) => ['tags', repo, query] as const,
  localTags: (repo: string) => ['local-tags', repo] as const,
  hfSize: (params: Record<string, unknown>) => ['hf-size', params] as const,
  search: (appType: string, q: string) => ['model-search', appType, q] as const,
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `TagPage` and `TAG_SORTS` in apps/backend/src/lib/registry-tags.ts.
 */
export const TAG_SORTS = ['newest', 'oldest', 'version', 'name'] as const
export type TagSort = typeof TAG_SORTS[number]

export const TAG_SORT_LABELS: Record<TagSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  version: 'Version',
  name: 'Name (A–Z)',
}

export interface TagPage {
  tags: string[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  sort: TagSort
}

export interface TagQuery {
  page?: number
  pageSize?: number
  sort?: TagSort
}

export const EMPTY_TAG_PAGE: TagPage = {
  tags: [], page: 1, pageSize: 30, total: 0, totalPages: 1, sort: 'newest',
}

export function useImageTags(repo: string, enabled: boolean, query: TagQuery = {}) {
  return useQuery({
    queryKey: modelKeys.tags(repo, query),
    queryFn: () => api.get<TagPage>('/registry/tags', {
      params: { repo, page: query.page, pageSize: query.pageSize, sort: query.sort },
    }).then((r) => r.data),
    enabled: enabled && !!repo,
    placeholderData: (prev) => prev,
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
  const tabbyQuery: TagQuery = { pageSize: 100 }
  const remote = useQuery({
    queryKey: modelKeys.tags(TABBY_IMAGE_REPO, tabbyQuery),
    queryFn: () => api.get<TagPage>('/registry/tags', {
      params: { repo: TABBY_IMAGE_REPO, pageSize: tabbyQuery.pageSize },
    }).then((r) => r.data.tags),
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
  sourceLabel?: string
  model: string
  baseUrl?: string
  isMesh?: boolean
  hasApiKey?: boolean
  gpuCount?: number
  clusterId?: string
  contextTokens?: number
  /**
   * ── DUPLICATED, KNOWINGLY ──
   * Authority: `ModelProvider.pricing` in apps/backend/src/lib/model-registry.ts, written from
   * `ModelEndpointMetadata.pricing`. Dollars per million tokens, as the gateway quoted them.
   */
  pricing?: { promptPerMTok: number; completionPerMTok: number }
  /** Artificial Analysis Intelligence Index, when their catalogue matched this model. */
  intelligence?: number
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

/**
 * The account's default engine. A pack that names no endpoint of its own runs on this, so moving
 * every pack from one provider to another is this one setting rather than an edit per pack.
 */
export const defaultModelKeys = {
  current: () => ['default-model'] as const,
}

export interface DefaultModelSetting {
  defaultModelId: string | null
  /** When true the default beats a pack's own engine instead of only filling in for one. */
  globalModelOverride: boolean
}

export const getDefaultModel = (): Promise<DefaultModelSetting> =>
  api.get<DefaultModelSetting>('/models/default').then((r) => r.data)

export const setGlobalModelOverride = (override: boolean): Promise<boolean> =>
  api.put<{ globalModelOverride: boolean }>('/models/default/override', { override })
    .then((r) => r.data.globalModelOverride)

export const setDefaultModel = (modelId: string | null): Promise<string | null> =>
  api.put<{ defaultModelId: string | null }>('/models/default', { modelId })
    .then((r) => r.data.defaultModelId)

export function useDefaultModel() {
  return useQuery({
    queryKey: defaultModelKeys.current(),
    queryFn: getDefaultModel,
  })
}
