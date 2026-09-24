import type { PlanProposal } from '@koala/harness-types'
import { api } from './client'

export const planKeys = {
  forConversation: (conversationId: string) => ['plans', conversationId] as const,
}

export const listPlans = (conversationId: string): Promise<PlanProposal[]> =>
  api.get<PlanProposal[]>('/plans', { params: { conversationId } }).then((r) => r.data)

export const approvePlan = (id: string): Promise<PlanProposal> =>
  api.post<PlanProposal>(`/plans/${id}/approve`).then((r) => r.data)

export const rejectPlan = (id: string, reason?: string): Promise<PlanProposal> =>
  api.post<PlanProposal>(`/plans/${id}/reject`, reason ? { reason } : {}).then((r) => r.data)
