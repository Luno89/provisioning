import { api, API_BASE } from '../../../api/client'

export interface MyInstance {
  instance: { id: string; url: string; unreachableSince?: string; signInWaiting?: string } | null
  servesTenants: boolean
}

export const identityKeys = {
  mine: () => ['identity', 'instance'] as const,
}

export const getMyInstance = (): Promise<MyInstance> =>
  api.get<MyInstance>('/identity/instance').then((r) => r.data)

export const INSTANCE_GO_URL = `${API_BASE}/identity/go`
