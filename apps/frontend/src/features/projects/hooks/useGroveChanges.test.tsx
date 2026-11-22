import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useGroveChanges } from './useGroveChanges'
import { GROVE_CHANGED, groveKeys } from '../api/grove'
import { projectKeys } from '../api/projects'
import { socketHandlers as handlers } from '../../../test/socket-events'

vi.mock('../../platform/stores/socket', () => import('../../../test/socket-events'))

describe('the grove changing elsewhere', () => {
  it('refreshes the trees the sidebar lists, their stories and the projects when the server says the grove changed', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => useGroveChanges(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

    await handlers.get(GROVE_CHANGED)!()

    expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([groveKeys.trees(), groveKeys.branches(), groveKeys.leaves(), projectKeys.list()])
  })
})
