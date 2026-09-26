import type { SecretRequest } from '@koala/harness-types'
import { api } from './client'

export const secretRequestKeys = {
  all: ['secret-requests'] as const,
  forConversation: (conversationId: string) => ['secret-requests', 'conversation', conversationId] as const,
  forTree: (treeId: string) => ['secret-requests', 'tree', treeId] as const,
}

export const listConversationSecretRequests = (conversationId: string): Promise<SecretRequest[]> =>
  api.get<SecretRequest[]>('/secret-requests', { params: { conversationId } }).then((r) => r.data)

export const listTreeSecretRequests = (treeId: string): Promise<SecretRequest[]> =>
  api.get<SecretRequest[]>('/secret-requests', { params: { treeId } }).then((r) => r.data)

export const submitSecret = (id: string, value: string): Promise<SecretRequest> =>
  api.post<SecretRequest>(`/secret-requests/${id}/submit`, { value }).then((r) => r.data)

export const dismissSecretRequest = (id: string): Promise<SecretRequest> =>
  api.post<SecretRequest>(`/secret-requests/${id}/dismiss`).then((r) => r.data)
