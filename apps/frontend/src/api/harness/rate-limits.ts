import { api } from '../client'

export interface ModelRateLimitBucketSnapshot {
  key: string
  label: string
  inFlight: number
  queued: number
  cooldownUntil?: string
  totalRequests: number
  total429: number
  totalErrors: number
  lastRequestAt?: string
  lastStatus?: number
}

export const rateLimitKeys = {
  list: () => ['harness-rate-limits'] as const,
}

export const getRateLimits = (): Promise<ModelRateLimitBucketSnapshot[]> =>
  api.get<ModelRateLimitBucketSnapshot[]>('/harness/rate-limits').then((r) => r.data)
