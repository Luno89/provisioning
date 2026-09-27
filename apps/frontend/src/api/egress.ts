import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types'
import { api } from './client'

export const egressKeys = {
  all: ['egress'] as const,
  requests: (scope: 'conversation' | 'tree', id: string) => ['egress', 'requests', scope, id] as const,
  grants: (agent: string) => ['egress', 'grants', agent] as const,
}

export const listEgressRequests = (scope: 'conversationId' | 'treeId', id: string): Promise<EgressRequest[]> =>
  api.get<EgressRequest[]>('/egress/requests', { params: { [scope]: id } }).then((r) => r.data)

export const allowEgress = (id: string): Promise<unknown> => api.post(`/egress/requests/${id}/allow`).then((r) => r.data)
export const dismissEgress = (id: string): Promise<unknown> => api.post(`/egress/requests/${id}/dismiss`).then((r) => r.data)

export const listEgressGrants = (agent: string): Promise<EgressGrantRecord[]> =>
  api.get<EgressGrantRecord[]>('/egress/grants', { params: { agent } }).then((r) => r.data)

export const revokeEgress = (id: string): Promise<unknown> => api.post(`/egress/grants/${id}/revoke`).then((r) => r.data)
