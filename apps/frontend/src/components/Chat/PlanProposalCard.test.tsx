import type { ReactNode } from 'react'
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'
import type { PlanProposal } from '@koala/harness-types'
import PlanProposalCard from './PlanProposalCard'

vi.mock('../../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/grove')>()),
  listLeaves: vi.fn(async () => [
    { id: 'l1', branchId: 'b1', title: 'Persists', status: 'running', tasks: ['t'], updatedAt: 'a' },
    { id: 'l2', branchId: 'b1', title: 'Slip', status: 'pending', tasks: [], updatedAt: 'a' },
  ]),
  listBranches: vi.fn(async () => []),
  getTreeRun: vi.fn(async () => ({ state: 'running', startedAt: 'a' })),
  listTreeTypes: vi.fn(async () => [
    { id: 'odoo-addons', label: 'Odoo addons', versions: { of: 'Odoo', choices: [{ version: '20', language: 'odoo-20' }, { version: '18', language: 'odoo' }], default: '20' } },
    { id: 'api-service', label: 'API service' },
  ]),
}))
vi.mock('../../api/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/plans')>()),
  listTreePlans: vi.fn(async () => []),
}))

const render = (ui: ReactNode) => rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

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
    expect(screen.getByText('Replaced by a newer plan')).toBeTruthy()
    expect(screen.queryByText('Approve')).toBeNull()
    expect(screen.queryByText('Reject')).toBeNull()
  })

  it('shows a leaf replan: which leaf, why, the new goal, the brief and the tasks', () => {
    renderCard({
      plan: undefined,
      leafPlan: {
        treeId: 't1', leafId: 'l1', leafTitle: 'Serve it', mode: 'replan',
        why: 'nginx is not installed; python3 is', body: 'curl :8080 answers with the page', brief: 'Use python3 -m http.server.',
        tasks: [{ key: 's', title: 'Serve with python', description: 'd', role: 'r', doneMeans: 'curl answers 200', dependsOn: [] }],
      },
    })
    expect(screen.getByText('Replan “Serve it”')).toBeTruthy()
    expect(screen.getByText('nginx is not installed; python3 is')).toBeTruthy()
    expect(screen.getByText('curl :8080 answers with the page')).toBeTruthy()
    expect(screen.getByText(/done means: curl answers 200/)).toBeTruthy()
    fireEvent.click(screen.getByText('Read the brief'))
    expect(screen.getByText('Use python3 -m http.server.')).toBeTruthy()
    expect(screen.queryByText('Read PLAN.md')).toBeNull()
  })
})


describe('a plan that names its service', () => {
  it('shows the service name and says when it joins an existing one', () => {
    const base = proposal()
    render(<PlanProposalCard proposal={{ ...base, plan: { ...base.plan!, tree: { name: 'Weather', type: 'api-service', serviceName: 'weather', joins: { treeId: 't0', treeName: 'Old weather', projectId: 'p0' } } } }} deciding={false} onApprove={() => {}} onReject={() => {}} />)
    expect(screen.getByText('weather')).toBeInTheDocument()
    expect(screen.getByText(/already belongs to “Old weather”/)).toBeInTheDocument()
  })

  it('shows a story change: what changes from what to what, what approving does, and decides it like a plan', () => {
    const { onApprove, onReject } = renderCard({
      plan: undefined,
      conversationId: 'story-chat',
      change: {
        treeId: 't1',
        why: 'the person wants it printed too',
        edit: { leafId: 'l1', body: 'The form and the printed order show the note', brief: 'Inherit the report too.' },
        before: [{ leafId: 'l1', title: 'Note on screen', status: 'running', body: 'The form shows the note', dependsOn: [], tasks: [] }],
        outcome: ['The worker on it now is stopped, and the story starts again from this change.'],
      },
    })
    expect(screen.getByText('Change “Note on screen”')).toBeTruthy()
    expect(screen.getByText('the person wants it printed too')).toBeTruthy()
    expect(screen.getByText('The form shows the note')).toBeTruthy()
    expect(screen.getByText('The form and the printed order show the note')).toBeTruthy()
    expect(screen.getByText(/The worker on it now is stopped/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Read the new brief' }))
    expect(screen.getByText('Inherit the report too.')).toBeTruthy()
    expect(screen.queryByText(/Read PLAN.md/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject change' }))
    expect(onReject).toHaveBeenCalled()
  })

  it('lists the stories a change adds or cancels, and drops what approving would do once it is applied', () => {
    renderCard({
      plan: undefined,
      status: 'adopted',
      change: {
        treeId: 't1', why: 'mail it too',
        add: { branchId: 'b1', branchTitle: 'The field', leaves: [{ key: 'mail', title: 'Mailed note', body: 'The email shows the note', brief: 'b', dependsOn: ['l1'], tasks: [] }] },
        before: [], outcome: ['The tree is run once they are added.'], names: { l1: 'Note on screen' },
      },
    })
    expect(screen.getByText('Add “Mailed note” to “The field”')).toBeTruthy()
    expect(screen.getByText('Applied')).toBeTruthy()
    expect(screen.getByText(/after Note on screen/)).toBeTruthy()
    expect(screen.queryByText(/The tree is run/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open the tree' })).toBeNull()
  })

  it('follows the stories it added once applied, and opens one', async () => {
    const onOpenStory = vi.fn()
    render(<PlanProposalCard
      proposal={proposal({
        status: 'adopted',
        plan: undefined,
        change: { treeId: 't1', why: 'w', add: { branchId: 'b1', branchTitle: 'The proof', leaves: [] }, before: [], outcome: [] },
        adopted: { treeId: 't1', branchIds: ['b1'], leafIds: { persist: 'l1', slip: 'l2' }, taskIds: {} },
      })}
      deciding={false} onApprove={() => {}} onReject={() => {}} onOpenStory={onOpenStory}
    />)
    expect(await screen.findByText('Added 2 stories to “The proof”')).toBeTruthy()
    expect(screen.getByText('“Persists” is being worked')).toBeTruthy()
    expect(screen.getByText('“Slip” waits its turn')).toBeTruthy()
    fireEvent.click(screen.getByText('Watch it work ›'))
    expect(onOpenStory).toHaveBeenCalledWith({ treeId: 't1', branchId: 'b1', leafId: 'l1' })
  })

  it('says which version a new tree will be: the one the plan chose, else the type\'s default', async () => {
    const odoo = (version?: string) => proposal({ plan: { ...proposal().plan!, tree: { name: 'Shop', type: 'odoo-addons', ...(version ? { version } : {}) } } })
    const { unmount } = render(<PlanProposalCard proposal={odoo()} deciding={false} onApprove={() => {}} onReject={() => {}} />)
    expect(await screen.findByTestId('plan-version')).toHaveTextContent('Odoo 20')
    unmount()
    render(<PlanProposalCard proposal={odoo('18')} deciding={false} onApprove={() => {}} onReject={() => {}} />)
    expect(await screen.findByTestId('plan-version')).toHaveTextContent('Odoo 18')
  })

  it('names no version for a type that has none', async () => {
    render(<PlanProposalCard proposal={proposal()} deciding={false} onApprove={() => {}} onReject={() => {}} />)
    await screen.findByText(/Widget API/)
    expect(screen.queryByTestId('plan-version')).toBeNull()
  })
})
