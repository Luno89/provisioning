import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client'
import type { MailReport } from '../../../shared/components/MailReport'

/**
 * ── DUPLICATED, KNOWINGLY ── `MailReputationView` in apps/backend/src/platform/services/MailReputation.ts is the authority.
 */
export interface MailReputationView {
  report?: MailReport
  checking: boolean
}

export const mailReputationKeys = {
  root: () => ['mail-reputation'] as const,
}

export const getMailReputation = (): Promise<MailReputationView> => api.get<MailReputationView>('/instances/mail-reputation').then((r) => r.data)

export const checkMailReputation = (): Promise<MailReputationView> => api.post<MailReputationView>('/instances/mail-reputation/check', {}).then((r) => r.data)

export function useMailReputation() {
  return useQuery({
    queryKey: mailReputationKeys.root(),
    queryFn: getMailReputation,
    refetchInterval: (query) => (query.state.data?.checking ? 3000 : false),
  })
}

export function useCheckMailReputation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: checkMailReputation,
    onSuccess: (view) => { client.setQueryData(mailReputationKeys.root(), view) },
  })
}
