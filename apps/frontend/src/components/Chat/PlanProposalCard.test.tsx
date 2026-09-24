import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { PlanProposal } from '@koala/harness-types'
import PlanProposalCard from './PlanProposalCard'

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({
  id: 'p1',
  ownerId: 'u1',
  status: 'proposed',
  plan: {
    tree: { name: 'Widget API', type: 'api-service' },
    planDoc: '# Widget API\n\nAssumption: Node 22.',
    branches: [{
      title: 'Operability',
      leaves: [
        { key: 'health', title: 'Health endpoint', body: 'GET /health answers 200', brief: 'b', dependsOn: [], tasks: [{ key: 'a', title: 'Handler', description: 'd', role: 'r', doneMeans: 'curl answers 200', dependsOn: [] }] },
        { key: 'deploy', title: 'Deploy', body: 'It runs', brief: 'b', dependsOn: ['health'], tasks: [] },
      ],
    }],
  },
  createdAt: 'now',
  updatedAt: 'now',
  ...over,
})

const renderCard = (over: Partial<PlanProposal> = {}) => {
  const onApprove = vi.fn()
  const onReject = vi.fn()
  const onOpenTree = vi.fn()
  render(<PlanProposalCard proposal={proposal(over)} deciding={false} onApprove={onApprove} onReject={onReject} onOpenTree={onOpenTree} />)
  return { onApprove, onReject, onOpenTree }
}

describe('PlanProposalCard', () => {
  it('shows the whole plan: the new tree, its branches, leaves, their goals and tasks', () => {
    renderCard()
    expect(screen.getByText('New api-service tree “Widget API”')).toBeTruthy()
    expect(screen.getByText('Operability')).toBeTruthy()
    expect(screen.getByText(/GET \/health answers 200/)).toBeTruthy()
    expect(screen.getByText(/done means: curl answers 200/)).toBeTruthy()
    expect(screen.getByText(/\(after health\)/)).toBeTruthy()
    expect(screen.getByText('No tasks yet — planned, not broken down.')).toBeTruthy()
    fireEvent.click(screen.getByText('Read PLAN.md'))
    expect(screen.getByText(/Assumption: Node 22/)).toBeTruthy()
  })

  it('approves on Approve', () => {
    const { onApprove } = renderCard()
    fireEvent.click(screen.getByText('Approve'))
    expect(onApprove).toHaveBeenCalled()
  })

  it('rejects with the reason typed', () => {
    const { onReject } = renderCard()
    fireEvent.click(screen.getByText('Reject'))
    fireEvent.change(screen.getByPlaceholderText(/What should change/), { target: { value: 'split the deploy leaf' } })
    fireEvent.click(screen.getByText('Reject plan'))
    expect(onReject).toHaveBeenCalledWith('split the deploy leaf')
  })

  it('offers a retry when building failed, with the reason', () => {
    renderCard({ status: 'failed', reason: 'the sandbox would not start' })
    expect(screen.getByText(/Building it failed — the sandbox would not start/)).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('opens the tree once adopted, and offers no decision any more', () => {
    const { onOpenTree } = renderCard({ status: 'adopted', adopted: { treeId: 't9', branchIds: [], leafIds: {}, taskIds: {} } })
    expect(screen.queryByText('Approve')).toBeNull()
    fireEvent.click(screen.getByText('Open the tree'))
    expect(onOpenTree).toHaveBeenCalledWith('t9')
  })

  it('shows a replaced plan without anything to decide', () => {
    renderCard({ status: 'superseded' })
    expect(screen.getByText('Replaced by a newer plan below')).toBeTruthy()
    expect(screen.queryByText('Approve')).toBeNull()
    expect(screen.queryByText('Reject')).toBeNull()
  })
})
