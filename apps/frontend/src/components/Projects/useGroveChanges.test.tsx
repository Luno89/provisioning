import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useGroveChanges } from './useGroveChanges'
import { GROVE_CHANGED, groveKeys } from '../../api/grove'
import { projectKeys } from '../../api/projects'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }))
vi.mock('../../stores/socket', () => ({
  useSocketEvent: (event: string, handler: () => void) => { handlers.set(event, handler) },
}))

describe('the grove changing elsewhere', () => {
  it('refreshes the trees the sidebar lists, their stories and the projects when the server says the grove changed', () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => useGroveChanges(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

    handlers.get(GROVE_CHANGED)!()

    expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([groveKeys.trees(), groveKeys.branches(), groveKeys.leaves(), projectKeys.list()])
  })
})
