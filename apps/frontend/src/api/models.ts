import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { useDebounce } from '../lib/use-debounce'

/**
 * Everything the deploy wizard asks about images and models.
 *
 * These queries lived in `App.tsx`, keyed on `wizardData` fields and gated on `wizardStep` — so App
 * was running six requests on behalf of a modal it also rendered, and passing eight
 * `data`/`isFetching`/`isError` values into it.
 *
 * They are hooks here, and each one is `enabled` on the condition that used to be an inline
 * `showAppModal && wizardStep === 4 && …`. A closed wizard makes no requests.
 */

/**
 * Written from the handler at `index.ts`'s `/api/models/hf-size`, not guessed — the first version
 * of this invented `kvCacheBytes` and `fitsInGpu`, neither of which exists, and the compiler found
 * it the moment the wizard's markup was typechecked against it.
 */
export interface HfModelSize {
  totalBytes: number
  fileCount: number
  /**
   * Undefined when the repo has no resolvable config — the handler only computes these when it can
   * read `config.json` and a sequence length, so the wizard has to render the unknown case.
   */
  kvCacheBytesPerGpu?: number | undefined
  weightBytesPerGpu?: number | undefined
}

export interface ModelSearchResult {
  id: string
  /** Always present from the search endpoint; the picker sorts and renders it. */
  downloads: number
  likes?: number
}

export const modelKeys = {
  tags: (repo: string) => ['tags', repo] as const,
  localTags: (repo: string) => ['local-tags', repo] as const,
  hfSize: (params: Record<string, unknown>) => ['hf-size', params] as const,
  search: (appType: string, q: string) => ['model-search', appType, q] as const,
}

/** Tags published for a container repository, for the image pickers on steps 4 and 5. */
export function useImageTags(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: modelKeys.tags(repo),
    queryFn: () => api.get<string[]>('/registry/tags', { params: { repo } }).then((r) => r.data),
    enabled: enabled && !!repo,
  })
}

/**
 * How large a Hugging Face model is, and whether it fits.
 *
 * Debounced at the call site rather than here: the caller owns the input, and a hook that debounced
 * internally would still re-run on every keystroke to do it.
 */
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
    // A model that does not exist is an answer, not a transient failure — retrying just delays the
    // "we could not find that" the user needs to see.
    retry: false,
  })
}

/**
 * Live Hugging Face search, replacing what used to be a hardcoded list of four or five models.
 *
 * An empty query still returns results, sorted by downloads, so it doubles as a trending list —
 * which is why `enabled` does not require a query string.
 */
export function useModelSearch(appType: string, query: string, enabled: boolean) {
  // 400ms rather than the default: this drives a result list, where the list IS the feedback, so it
  // wants to feel closer to live than a size estimate does.
  const debounced = useDebounce(query, 400)
  return useQuery({
    queryKey: modelKeys.search(appType, debounced),
    queryFn: () => api.get<ModelSearchResult[]>('/models/search', {
      params: { q: debounced, appType },
    }).then((r) => r.data),
    enabled,
  })
}

/** The TabbyAPI image, whose published tags change upstream independently of this codebase. */
export const TABBY_IMAGE_REPO = 'ghcr.io/theroyallab/tabbyapi';

const TABBY_IMAGE_TAG_HINTS: Record<string, string> = {
  latest: 'CUDA 12.8',
  cu13: 'CUDA 13.x',
};

export interface TabbyImageTag {
  tag: string
  /** Already in the host Docker cache, so it deploys instantly with no pull. */
  cached: boolean
  label: string
}

/**
 * Which TabbyAPI image tags are available, merging what is downloadable with what is already
 * cached locally.
 *
 * ── WHY THIS IS A SHARED HOOK AND NOT WIZARD STATE ──
 * Two screens show this picker: step 4 of the deploy wizard, and the config tab of the log modal
 * for a running TabbyAPI deployment. In App.tsx that was one query with an `enabled` condition
 * OR-ing both cases together — which is why moving it into the wizard would have silently broken
 * the other one. A hook lets both ask for it, and react-query dedupes the request.
 *
 * Fetched live rather than hardcoded: ghcr.io/theroyallab/tabbyapi adds and drops CUDA variants
 * upstream on its own schedule.
 */
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

/**
 * The branches of a Hugging Face repo.
 *
 * Only relevant for TabbyAPI: EXL2/EXL3 quants split their bits-per-weight variants across branches
 * of one repo, so picking a model is not enough on its own — `main` is often just a README pointer
 * with no weights in it.
 */
export function useHfBranches(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ['hf-branches', repo] as const,
    queryFn: () => api.get<string[]>('/models/hf-branches', { params: { repo } }).then((r) => r.data),
    enabled: enabled && !!repo,
    staleTime: 30_000,
  })
}

/**
 * A model the platform can talk to — either deployed here or a remote endpoint someone added.
 *
 * Moved out of `Chat.tsx`, where it was private, because the composer and the endpoint form both
 * read it and the two had drifted into describing it slightly differently.
 */
export interface ModelProvider {
  id: string
  name: string
  /**
   * Where it came from. `deployment` is one this platform deployed and can port-forward to;
   * `endpoint` is a remote address someone registered. The composer treats them differently —
   * only a deployment has a GPU count to show.
   */
  source: 'deployment' | 'endpoint'
  kind?: 'vllm' | 'tabbyapi'
  model: string
  baseUrl?: string
  /** Reachable over the Headscale mesh rather than the public internet. */
  isMesh?: boolean
  hasApiKey?: boolean
  gpuCount?: number
}

export const providerKeys = {
  list: () => ['models'] as const,
}

export const listModels = (): Promise<ModelProvider[]> =>
  api.get<ModelProvider[]>('/models').then((r) => r.data)

/**
 * Registers a remote OpenAI-compatible endpoint.
 *
 * The backend refuses some addresses (private ranges, loopback) and its refusal names WHICH range
 * and why — that text is the only useful guidance a user gets here, so callers surface it rather
 * than a generic failure. `errorMessage` reads it.
 */
export const addModelEndpoint = (form: {
  name: string; baseUrl: string; model: string; apiKey?: string
}): Promise<ModelProvider> =>
  api.post<ModelProvider>('/model-endpoints', form).then((r) => r.data)

export const removeModelEndpoint = (id: string): Promise<void> =>
  api.delete(`/model-endpoints/${id}`).then(() => undefined)
