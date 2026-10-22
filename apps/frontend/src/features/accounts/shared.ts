import { getNotifications, notificationKeys, sendTestEmail, setEmailChoice, type EmailChoice, type NotificationView } from '../monitoring'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountKeys, getPersonRemoval, getRemovalPreview, listInvites, listPeople, mintInvite, removeMyAccount, removePerson } from './api'
import { getInstanceAddresses, instanceAddressKeys, setNestedAddresses } from '../instances'
import { deploymentKeys } from '../infrastructure'
import { accountRemovalPlace } from '../platform'

export { confirmMatches, refusalBlockers, removalText } from './lib/removal-text'

export const dangerPanel = 'pt-6 border-t border-slate-700'
export const dangerButton = 'text-xs font-bold px-3 py-2 rounded-xl bg-red-700 hover:bg-red-600 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
export const quietButton = 'text-xs font-bold px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 transition-colors cursor-pointer'
export const emailField = 'w-full bg-slate-900/60 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white'

export function useRemovalPreview(enabled: boolean) {
  return useQuery({ queryKey: accountKeys.removal(), queryFn: getRemovalPreview, enabled })
}

export function useRemoveMyAccount(onRemoved: () => void) {
  return useMutation({ mutationFn: (confirm: string) => removeMyAccount(confirm), onSuccess: onRemoved })
}

export function useAccountRemovalPlace(enabled: boolean) {
  return useQuery({ queryKey: ['auth', 'account-removal'], queryFn: accountRemovalPlace, enabled, staleTime: Infinity })
}

export function usePeople() {
  return useQuery({
    queryKey: accountKeys.people(),
    queryFn: listPeople,
    refetchInterval: (query) => (query.state.data?.some((person) => person.removal && person.removal.state.state === 'running') ? 3_000 : false),
  })
}

export function useInvites() {
  return useQuery({ queryKey: accountKeys.invites(), queryFn: listInvites })
}

export function useMintInvite() {
  const client = useQueryClient()
  return useMutation({ mutationFn: mintInvite, onSuccess: () => { void client.invalidateQueries({ queryKey: accountKeys.invites() }) } })
}

export function usePersonRemoval(id: string, enabled: boolean) {
  return useQuery({ queryKey: accountKeys.personRemoval(id), queryFn: () => getPersonRemoval(id), enabled })
}

export function useRemovePerson() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: string }) => removePerson(id, confirm),
    onSettled: () => { void client.invalidateQueries({ queryKey: accountKeys.people() }) },
  })
}

export function useInstanceAddresses() {
  return useQuery({
    queryKey: instanceAddressKeys.mine(),
    queryFn: getInstanceAddresses,
    refetchInterval: (query) => (query.state.data?.nested && query.state.data.state === 'issuing' ? 5000 : false),
  })
}

export function useSetNestedAddresses() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (nested: boolean) => setNestedAddresses(nested),
    onSuccess: (view) => {
      client.setQueryData(instanceAddressKeys.mine(), view)
      void client.invalidateQueries({ queryKey: deploymentKeys.all })
    },
  })
}

export function useNotifications() {
  return useQuery({ queryKey: notificationKeys.mine(), queryFn: getNotifications })
}

export function useSetEmailChoice() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (email: EmailChoice) => setEmailChoice(email),
    onSuccess: (view) => { client.setQueryData(notificationKeys.mine(), (old: NotificationView | undefined) => ({ ...old, ...view })) },
  })
}

export function useSendTestEmail() {
  return useMutation({ mutationFn: () => sendTestEmail() })
}

