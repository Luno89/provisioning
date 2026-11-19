import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PROVISIONING_CHANGED } from '@koala/engine-core/koala-install'
import { useSocketEvent } from '../../platform'
import { getProvisioning, provisioningKeys, setUpAgain } from '../api/provisioning'

export function useProvisioning() {
  const queries = useQueryClient()
  useSocketEvent(PROVISIONING_CHANGED, () => { void queries.invalidateQueries({ queryKey: provisioningKeys.view() }) })
  return useQuery({ queryKey: provisioningKeys.view(), queryFn: getProvisioning })
}

export function useSetUpAgain() {
  const queries = useQueryClient()
  return useMutation({
    mutationFn: (clusterId: string) => setUpAgain(clusterId),
    onSuccess: () => queries.invalidateQueries({ queryKey: provisioningKeys.view() }),
  })
}
