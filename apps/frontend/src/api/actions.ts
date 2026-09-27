import type { ActionProposal } from '@koala/harness-types'
import { api } from './client'

export const actionKeys = {
  all: ['actions'] as const,
  forConversation: (conversationId: string) => ['actions', 'conversation', conversationId] as const,
  forTree: (treeId: string) => ['actions', 'tree', treeId] as const,
}

export const listConversationActions = (conversationId: string): Promise<ActionProposal[]> =>
  api.get<ActionProposal[]>('/actions', { params: { conversationId } }).then((r) => r.data)

export const listTreeActions = (treeId: string): Promise<ActionProposal[]> =>
  api.get<ActionProposal[]>('/actions', { params: { treeId } }).then((r) => r.data)

export const applyAction = (id: string): Promise<ActionProposal> =>
  api.post<ActionProposal>(`/actions/${id}/apply`).then((r) => r.data)

export const rejectAction = (id: string): Promise<ActionProposal> =>
  api.post<ActionProposal>(`/actions/${id}/reject`).then((r) => r.data)
