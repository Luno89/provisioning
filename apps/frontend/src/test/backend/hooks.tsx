import type { ReactNode } from 'react'
import { act, getConfig, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query'
import { getSocket } from '../../features/platform'

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

export interface ShownPage {
  client: QueryClient
}

export function shown<T>(find: () => T | null, page?: ShownPage): Promise<T> {
  return getConfig().asyncWrapper(() => new Promise<T>((resolve, reject) => {
    const ends: Array<() => void> = []
    const end = () => { for (const stop of ends.splice(0)) stop() }
    const look = (): boolean => {
      let found: T | null
      try {
        found = find()
      } catch (err) {
        end()
        reject(err as Error)
        return true
      }
      if (!found) return false
      end()
      resolve(found)
      return true
    }
    const cannotCome = (why: string) => { end(); reject(new Error(`what this waits for can never be shown: ${why}`)) }
    if (look()) return
    const watch = new MutationObserver(() => { look() })
    watch.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    ends.push(() => watch.disconnect())
    if (!page) return
    ends.push(page.client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') cannotCome(`the page's ${JSON.stringify(event.query.queryKey)} failed: ${(event.action.error as Error).message}`)
    }))
    ends.push(page.client.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') cannotCome(`the page's change failed: ${(event.action.error as Error).message}`)
    }))
    const socket = getSocket()
    const closed = (reason: string) => cannotCome(`the page's socket closed (${reason}), so no change reaches it`)
    if (!socket.connected) return cannotCome('the page\'s socket is not connected, so no change reaches it')
    socket.on('disconnect', closed)
    ends.push(() => { socket.off('disconnect', closed) })
  }))
}
