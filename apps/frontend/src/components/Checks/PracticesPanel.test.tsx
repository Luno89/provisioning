import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PracticesPanel from './PracticesPanel'
import type { Practice } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, listPractices: vi.fn(), makePracticeLive: vi.fn(async () => undefined), retirePractice: vi.fn(async () => undefined) }
})

const { listPractices, makePracticeLive, retirePractice } = await import('../../api/evals')

const practice = (over: Partial<Practice>): Practice => ({ id: 'p', agent: 'koala', title: 'Check first', text: 'Call list_infrastructure first.', status: 'active', createdAt: 'a', updatedAt: 'a', ...over })

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><PracticesPanel /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listPractices).mockResolvedValue([
    practice({ id: 'held', title: 'Held one', status: 'pending_review', trial: { checkedAt: 'b', runId: 'r-4', scenarios: ['koala-cluster'], regressions: ['koala-cluster'] } }),
    practice({ id: 'trial', title: 'Trial one', status: 'trial' }),
    practice({ id: 'live', title: 'Live one', status: 'active', trial: { checkedAt: 'b', runId: 'r-3', scenarios: ['a', 'b'], regressions: [] } }),
  ])
})

describe('practices', () => {
  it('groups them by where they stand, saying what each trial found', async () => {
    show()

    expect(await screen.findByText('Held for you (1)')).toBeInTheDocument()
    expect(screen.getByText('Trial: regressed koala-cluster in bench run r-4')).toBeInTheDocument()
    expect(screen.getByText('On trial (1)')).toBeInTheDocument()
    expect(screen.getByText('Trial: nothing regressed across 2 scenarios')).toBeInTheDocument()
  })

  it('lets the person put a held one live anyway, and retire any of them', async () => {
    show()

    const held = (await screen.findByText('Held one')).closest('li')!
    await userEvent.click(within(held).getByRole('button', { name: 'Make live' }))
    await waitFor(() => expect(makePracticeLive).toHaveBeenCalledWith('held'))

    const live = screen.getByText('Live one').closest('li')!
    expect(within(live).queryByRole('button', { name: 'Make live' })).not.toBeInTheDocument()
    await userEvent.click(within(live).getByRole('button', { name: 'Retire' }))
    await waitFor(() => expect(retirePractice).toHaveBeenCalledWith('live'))
  })
})
