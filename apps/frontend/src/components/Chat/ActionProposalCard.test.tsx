import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ActionProposal } from '@koala/harness-types'
import ActionProposalCard from './ActionProposalCard'

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: 'a1', ownerId: 'u1', kind: 'deploy_project', summary: 'deploy billing from build b1',
  detail: ['Project: billing', 'Image: reg/billing:abc'], params: {}, status: 'proposed', createdAt: 'x', updatedAt: 'x', ...over,
})

describe('ActionProposalCard', () => {
  it('shows exactly what will happen, and applies or rejects', () => {
    const onApply = vi.fn()
    const onReject = vi.fn()
    render(<ActionProposalCard proposal={proposal()} busy={false} onApply={onApply} onReject={onReject} />)
    expect(screen.getByText('Image: reg/billing:abc')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('offers a retry with the reason when it failed, and nothing once applied', () => {
    const { rerender } = render(<ActionProposalCard proposal={proposal({ status: 'failed', reason: 'no memory' })} busy={false} onApply={() => {}} onReject={() => {}} />)
    expect(screen.getByText(/no memory/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    rerender(<ActionProposalCard proposal={proposal({ status: 'applied', result: 'deploying billing' })} busy={false} onApply={() => {}} onReject={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('deploying billing')).toBeInTheDocument()
  })
})
