import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ProposalsPanel from './ProposalsPanel'
import type { ScenarioProposal } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, listProposals: vi.fn(), acceptProposal: vi.fn(), dismissProposal: vi.fn(async () => undefined) }
})

const { listProposals, acceptProposal, dismissProposal } = await import('../../api/evals')

const proposal = (over: Partial<ScenarioProposal> = {}): ScenarioProposal => ({
  id: 'koala-checks-tasks',
  why: 'In run r-9 it guessed without looking at the tasks.',
  status: 'proposed',
  createdAt: '2026-10-03T12:00:00Z',
  scenario: {
    id: 'koala-checks-tasks', name: 'Checks tasks first', describe: 'It looks before it answers.', agent: 'koala',
    procedure: { id: 'interactive-chat' }, input: { message: 'What next?' }, expect: { toolsCalled: ['list_tasks'] },
  },
  ...over,
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ProposalsPanel agents={['koala']} procedures={['interactive-chat']} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listProposals).mockResolvedValue([proposal(), proposal({ id: 'old', status: 'accepted' })])
})

describe('proposed tests', () => {
  it('shows only what is waiting, with why it was proposed and what it expects', async () => {
    show()

    expect(await screen.findByText('Proposed tests (1)')).toBeInTheDocument()
    expect(screen.getByText('Why: In run r-9 it guessed without looking at the tasks.')).toBeInTheDocument()
    expect(screen.getByText('Asks “What next?” and expects it calls list_tasks.')).toBeInTheDocument()
  })

  it('accepts one into the scenarios, or dismisses it', async () => {
    vi.mocked(acceptProposal).mockResolvedValue(proposal().scenario)
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(acceptProposal).toHaveBeenCalledWith('koala-checks-tasks'))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(dismissProposal).toHaveBeenCalledWith('koala-checks-tasks'))
  })

  it('shows nothing when nothing is waiting', async () => {
    vi.mocked(listProposals).mockResolvedValue([proposal({ status: 'dismissed' })])
    const { container } = show()
    await waitFor(() => expect(listProposals).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
