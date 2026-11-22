import type { ReactNode } from 'react'
import { act, getConfig, render, renderHook } from '@testing-library/react'
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
  followsSocket: boolean
}

export function openPage(part: ReactNode, { followsSocket }: { followsSocket: boolean }) {
  const client = freshClient()
  const page = render(<QueryClientProvider client={client}>{part}</QueryClientProvider>)
  const shownPage: ShownPage = { client, followsSocket }
  return { page, client, on: <T,>(find: () => T | null) => shown(find, shownPage) }
}

export function shown<T>(find: () => T | null, page: ShownPage): Promise<T> {
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
    let failure: string | undefined
    const judge = () => {
      if (look() || failure === undefined || page.client.isFetching() || page.client.isMutating()) return
      const said = Array.from(document.body.querySelectorAll<HTMLElement>('[role="alert"]'), (alert: HTMLElement) => alert.textContent ?? '').filter(Boolean)
      if (said.length) cannotCome(`${failure}, and the page shows ${said.map((text) => JSON.stringify(text)).join(', ')}`)
    }
    const settle = (said: string | undefined) => { failure ??= said }
    if (look()) return
    const watch = new MutationObserver(judge)
    watch.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    ends.push(() => watch.disconnect())
    ends.push(page.client.getQueryCache().subscribe((event) => {
      settle(event.type === 'updated' && event.action.type === 'error' ? `the page's ${JSON.stringify(event.query.queryKey)} failed: ${(event.action.error as Error).message}` : undefined)
    }))
    ends.push(page.client.getMutationCache().subscribe((event) => {
      settle(event.type === 'updated' && event.action.type === 'error' ? `the page's change failed: ${(event.action.error as Error).message}` : undefined)
    }))
    if (!page.followsSocket) return
    const socket = getSocket()
    const closed = (reason: string) => cannotCome(`the page's socket closed (${reason}), so no change reaches it`)
    if (!socket.connected) return cannotCome('the page\'s socket is not connected, so no change reaches it')
    socket.on('disconnect', closed)
    ends.push(() => { socket.off('disconnect', closed) })
  }))
}
