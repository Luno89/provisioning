import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ClaimReview from './ClaimReview'
import * as groveApi from '../api/grove'
import type { Leaf } from './leaf-types'

vi.mock('../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  settleLeaf: vi.fn(async () => ({})),
}))

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', branchId: 'b1', title: 'Serve it', status: 'claimed', depth: 0, blocking: false, childCount: 0, updatedAt: 'now',
  claim: { evidence: 'curl answered 200', commit: 'c0ffee1234567890', at: '2026-09-24T00:00:00.000Z' },
  review: { verdict: 'concern', reason: 'the port was never probed', at: '2026-09-24T00:01:00.000Z' },
  ...over,
})

const renderReview = (value: Leaf) => render(
  <QueryClientProvider client={new QueryClient()}>
    <ClaimReview leaf={value} />
  </QueryClientProvider>,
)

describe('ClaimReview', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows a parked claim with the judge\'s note, the evidence and the commit, and settles it as met', async () => {
    renderReview(leaf())
    expect(screen.getByText(/waiting for you/)).toBeTruthy()
    expect(screen.getByText('the port was never probed')).toBeTruthy()
    expect(screen.getByText('curl answered 200')).toBeTruthy()
    expect(screen.getByText(/c0ffee123456/)).toBeTruthy()

    fireEvent.click(screen.getByText('It meets the goal'))
    await waitFor(() => expect(groveApi.settleLeaf).toHaveBeenCalledWith('l1', 'verified', undefined))
  })

  it('fails it only with a reason', async () => {
    renderReview(leaf())
    fireEvent.click(screen.getByText('It failed…'))
    const fail = screen.getByText('Fail it') as HTMLButtonElement
    expect(fail.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/What does it miss/), { target: { value: 'serves the wrong page' } })
    fireEvent.click(fail)
    await waitFor(() => expect(groveApi.settleLeaf).toHaveBeenCalledWith('l1', 'failed', 'serves the wrong page'))
  })

  it('offers nothing to decide while the judge still has the claim', () => {
    const { review: _review, ...judgePending } = leaf()
    renderReview(judgePending)
    expect(screen.getByText('Claimed — waiting for the judge')).toBeTruthy()
    expect(screen.queryByText('It meets the goal')).toBeNull()
  })
})
