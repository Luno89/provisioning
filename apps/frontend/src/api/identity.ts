import { api, API_BASE } from './client'

export interface MyInstance {
  instance: { id: string; url: string } | null
  servesTenants: boolean
}

export const identityKeys = {
  mine: () => ['identity', 'instance'] as const,
}

export const getMyInstance = (): Promise<MyInstance | null> =>
  api.get<MyInstance>('/identity/instance').then((r) => r.data).catch(() => null)

export const INSTANCE_GO_URL = `${API_BASE}/identity/go`
