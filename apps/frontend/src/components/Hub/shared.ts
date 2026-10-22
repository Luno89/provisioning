import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDebounce } from '../../shared/lib/use-debounce'
import {
  acceptInvitation, checkGroup, changeMemberRole, deleteSharedProject, getSharing, shareProject, sharingKeys, takeProjectBack, getInvitation, getRootInvitation, getSharedProject, hubKeys,
  inviteToProject, listSharedProjects, removeMember, takeInviteBack,
} from '../../api/hub'
import type { HubRole } from '../../types/hub'

export const ROLE_SAID: Record<HubRole, { title: string; can: string }> = {
  owner: { title: 'Owner', can: 'Everything: releases, secrets, settings, and who is on the project.' },
  collaborator: { title: 'Collaborator', can: 'Works stories, sees the code, approves plans and changes.' },
  client: { title: 'Client', can: 'Sees how it is going, comments, and asks for changes, which wait for approval. No code, secrets or settings.' },
}

export function useSharedProjects() {
  return useQuery({ queryKey: hubKeys.mine, queryFn: listSharedProjects })
}

export function useSharedProject(id: string) {
  return useQuery({ queryKey: hubKeys.project(id), queryFn: () => getSharedProject(id), retry: false })
}

export function useSharing(projectId: string) {
  const client = useQueryClient()
  const preview = useQuery({ queryKey: sharingKeys.of(projectId), queryFn: () => getSharing(projectId) })
  const settle = (next: Awaited<ReturnType<typeof getSharing>>) => {
    client.setQueryData(sharingKeys.of(projectId), next)
    void client.invalidateQueries({ queryKey: hubKeys.mine })
  }
  const share = useMutation({ mutationFn: (group: string) => shareProject(projectId, group), onSuccess: settle })
  const takeBack = useMutation({ mutationFn: (confirm: string) => takeProjectBack(projectId, confirm), onSuccess: settle })
  return { preview, share, takeBack }
}

export function useGroupCheck(projectId: string, name: string, enabled: boolean) {
  const settled = useDebounce(name)
  const check = useQuery({ queryKey: sharingKeys.group(projectId, settled), queryFn: () => checkGroup(projectId, settled), staleTime: 5000, enabled })
  return { check, settled: settled === name }
}

export function usePeopleChanges(id: string) {
  const client = useQueryClient()
  const refresh = () => {
    void client.invalidateQueries({ queryKey: hubKeys.project(id) })
    void client.invalidateQueries({ queryKey: hubKeys.mine })
  }
  const invite = useMutation({ mutationFn: (body: { email: string; role: HubRole }) => inviteToProject(id, body), onSuccess: refresh })
  const takeBack = useMutation({ mutationFn: (email: string) => takeInviteBack(id, email), onSuccess: refresh })
  const changeRole = useMutation({ mutationFn: ({ personId, role }: { personId: string; role: HubRole }) => changeMemberRole(id, personId, role), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (personId: string) => removeMember(id, personId), onSuccess: refresh })
  const deleteProject = useMutation({
    mutationFn: (name: string) => deleteSharedProject(id, name),
    onSuccess: () => {
      client.removeQueries({ queryKey: hubKeys.project(id) })
      void client.invalidateQueries({ queryKey: hubKeys.mine })
    },
  })
  return { invite, takeBack, changeRole, remove, deleteProject }
}

export function useInvitation(token: string) {
  return useQuery({ queryKey: hubKeys.invitation(token), queryFn: () => getInvitation(token), retry: false })
}

export function useAcceptInvitation(token: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => acceptInvitation(token),
    onSuccess: (view) => {
      client.setQueryData(hubKeys.project(view.project.id), view)
      void client.invalidateQueries({ queryKey: hubKeys.mine })
    },
  })
}

export function useRootInvitation(code: string) {
  return useQuery({ queryKey: hubKeys.rootInvitation(code), queryFn: () => getRootInvitation(code), enabled: Boolean(code), retry: false })
}
