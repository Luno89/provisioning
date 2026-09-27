import type { AccessRequest } from '@koala/harness-types'
import { api } from './client'

export const accessKeys = {
  all: ['cluster-access'] as const,
  forConversation: (conversationId: string) => ['cluster-access', conversationId] as const,
}

export const listAccessRequests = (conversationId: string): Promise<AccessRequest[]> =>
  api.get<AccessRequest[]>('/cluster-access', { params: { conversationId } }).then((r) => r.data)

export const grantAccess = (id: string): Promise<AccessRequest> => api.post<AccessRequest>(`/cluster-access/${id}/grant`).then((r) => r.data)
export const dismissAccess = (id: string): Promise<AccessRequest> => api.post<AccessRequest>(`/cluster-access/${id}/dismiss`).then((r) => r.data)
