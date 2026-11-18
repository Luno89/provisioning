import type { ReactNode } from 'react'
import { act, getConfig, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query'

const freshClient = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

const providing = (client: QueryClient) => function Provider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

export async function queried<T>(useHook: () => UseQueryResult<T>): Promise<UseQueryResult<T>> {
  const client = freshClient()
  let settle: (result: UseQueryResult<T>) => void = () => undefined
  const settled = new Promise<UseQueryResult<T>>((resolve) => { settle = resolve })
  const view = renderHook(() => {
    const result = useHook()
    if (!result.isFetching && !result.isPending) settle(result)
    return result
  }, { wrapper: providing(client) })
  const answered = await act(() => settled)
  view.unmount()
  client.clear()
  return answered
}

export async function mutated<Variables, Result>(useHook: () => UseMutationResult<Result, Error, Variables>, variables: Variables): Promise<Result> {
  const client = freshClient()
  const view = renderHook(useHook, { wrapper: providing(client) })
  const result = await act(() => view.result.current.mutateAsync(variables))
  view.unmount()
  client.clear()
  return result
}

export function shown<T>(find: () => T | null): Promise<T> {
  return getConfig().asyncWrapper(() => new Promise<T>((resolve) => {
    const now = find()
    if (now) return resolve(now)
    const watch = new MutationObserver(() => {
      const found = find()
      if (!found) return
      watch.disconnect()
      resolve(found)
    })
    watch.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  }))
}
