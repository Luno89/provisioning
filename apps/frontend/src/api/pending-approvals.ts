import { api } from './client'

export const pendingApprovalKeys = {
  list: () => ['pending-approvals'] as const,
}

export interface PendingApproval {
  id: string
  leafId: string
  projectId?: string
  command: string
  status: 'pending' | 'approved' | 'denied'
  createdAt: string
}

export const listPendingApprovals = (): Promise<PendingApproval[]> =>
  api.get<PendingApproval[]>('/pending-approvals').then((r) => r.data)

export const decideApproval = (id: string, decision: 'approved' | 'denied') =>
  api.post(`/pending-approvals/${id}/decide`, { decision }).then((r) => r.data)
