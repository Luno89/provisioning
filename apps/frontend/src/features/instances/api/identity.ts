import { api, API_BASE, noneWhenMissing } from '../../../api/client'

export interface MyInstance {
  instance: { id: string; url: string; unreachableSince?: string } | null
  servesTenants: boolean
}

export const identityKeys = {
  mine: () => ['identity', 'instance'] as const,
}

export const getMyInstance = (): Promise<MyInstance | null> =>
  api.get<MyInstance>('/identity/instance').then((r) => r.data, noneWhenMissing)

export const INSTANCE_GO_URL = `${API_BASE}/identity/go`
