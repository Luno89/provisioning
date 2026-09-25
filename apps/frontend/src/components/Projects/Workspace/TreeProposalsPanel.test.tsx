import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlanProposal } from '@koala/harness-types'
import { TreeProposalsPanel } from './TreeProposalsPanel.js'
import * as plansApi from '../../../api/plans.js'

vi.mock('../../../api/plans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof plansApi>()),
  listTreePlans: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
}))

const leafProposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({
  id: 'p1', ownerId: 'u', status: 'proposed', createdAt: 'now', updatedAt: 'now',
  leafPlan: { treeId: 't1', leafId: 'l1', leafTitle: 'Serve it', mode: 'replan', why: 'w', brief: 'b', tasks: [] },
  ...over,
})

const renderPanel = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TreeProposalsPanel treeId="t1" />
  </QueryClientProvider>,
)

describe('TreeProposalsPanel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows the tree\'s open plans, leaf and growth alike, and approves one', async () => {
    vi.mocked(plansApi.listTreePlans).mockResolvedValue([
      leafProposal(),
      leafProposal({ id: 'old', status: 'adopted' }),
      leafProposal({ id: 'tree-plan', leafPlan: undefined, plan: { treeId: 't1', planDoc: '# Grow it', branches: [] } }),
    ])
    vi.mocked(plansApi.approvePlan).mockResolvedValue(leafProposal({ status: 'adopting' }))
    renderPanel()

    expect(await screen.findByText('Replan “Serve it”')).toBeTruthy()
    expect(screen.getAllByTestId('plan-proposal')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('Approve')[0]!)
    await waitFor(() => expect(plansApi.approvePlan).toHaveBeenCalledWith('p1'))
    expect(plansApi.listTreePlans).toHaveBeenCalledWith('t1')
  })

  it('says so when nothing waits', async () => {
    vi.mocked(plansApi.listTreePlans).mockResolvedValue([])
    renderPanel()
    expect(await screen.findByText('No plans waiting.')).toBeTruthy()
  })

  it('refreshes the conversation that proposed it, so its card stops asking', async () => {
    vi.mocked(plansApi.listTreePlans).mockResolvedValue([leafProposal()])
    vi.mocked(plansApi.approvePlan).mockResolvedValue(leafProposal({ status: 'adopting' }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(plansApi.planKeys.forConversation('conv-1'), [leafProposal()])
    render(<QueryClientProvider client={qc}><TreeProposalsPanel treeId="t1" /></QueryClientProvider>)

    fireEvent.click(await screen.findByText('Approve'))
    await waitFor(() => expect(qc.getQueryState(plansApi.planKeys.forConversation('conv-1'))?.isInvalidated).toBe(true))
  })
})
