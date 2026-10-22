import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { PlanProposal } from '@koala/harness-types'
import * as plansApi from '../../projects/api/plans'
import { usePlanProposals } from './usePlanProposals'

vi.mock('../../projects/api/plans', async (orig) => ({ ...(await orig<typeof plansApi>()), listPlans: vi.fn() }))

const change = (status: PlanProposal['status']): PlanProposal => ({
  id: 'p1', ownerId: 'u1', status, createdAt: 't', updatedAt: 't',
  change: { treeId: 't1', why: 'w', cancel: ['l1'], before: [], outcome: [] },
})

describe('usePlanProposals', () => {
  it('refreshes the board once a change it shows is applied', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    vi.mocked(plansApi.listPlans).mockResolvedValueOnce([change('adopting')]).mockResolvedValue([change('adopted')])
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => usePlanProposals('story-chat', false), { wrapper })

    await waitFor(() => expect(result.current.plans[0]?.status).toBe('adopting'))
    expect(invalidated).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.plans[0]?.status).toBe('adopted'), { timeout: 5000 })
    await waitFor(() => expect(invalidated.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([['leaves'], ['branches'], ['engine', 'tasks']]))
  })
})
