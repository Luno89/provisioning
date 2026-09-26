import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { SecretRequest } from '@koala/harness-types'
import { dismissSecretRequest, secretRequestKeys, submitSecret } from '../../../api/secret-requests'
import { errorMessage } from '../../../api/client'

export function useSecretRequests(key: QueryKey, list: () => Promise<SecretRequest[]>, enabled: boolean, streaming = false) {
  const qc = useQueryClient()
  const { data: requests = [] } = useQuery<SecretRequest[]>({ queryKey: key, queryFn: list, enabled })

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void qc.invalidateQueries({ queryKey: secretRequestKeys.all })
    wasStreaming.current = streaming
  }, [streaming, qc])

  const settled = () => { void qc.invalidateQueries({ queryKey: secretRequestKeys.all }) }
  const submit = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => submitSecret(id, value),
    onSuccess: settled,
    gcTime: 0,
  })
  const dismiss = useMutation({ mutationFn: (id: string) => dismissSecretRequest(id), onSuccess: settled })

  return {
    requests,
    submit: (id: string, value: string, done: () => void) => submit.mutate({ id, value }, { onSuccess: done }),
    dismiss: (id: string) => dismiss.mutate(id),
    busy: submit.isPending || dismiss.isPending,
    error: submit.error || dismiss.error ? errorMessage(submit.error ?? dismiss.error) || 'That did not go through.' : undefined,
  }
}
