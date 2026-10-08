import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountKeys, getPersonRemoval, getRemovalPreview, listPeople, removeMyAccount, removePerson } from '../../api/account'

export { confirmMatches, refusalBlockers, removalText } from './removal-text'

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

export function usePeople() {
  return useQuery({
    queryKey: accountKeys.people(),
    queryFn: listPeople,
    refetchInterval: (query) => (query.state.data?.some((person) => person.removal && person.removal.state.state === 'running') ? 3_000 : false),
  })
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
