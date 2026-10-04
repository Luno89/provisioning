import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ChangesPanel from './ChangesPanel'
import type { AgentChange } from '../../api/evals'

const navigate = vi.fn(async () => undefined)
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, listChanges: vi.fn(), acceptChange: vi.fn(), handOverChange: vi.fn(), dismissChange: vi.fn(async () => undefined) }
})

const { listChanges, acceptChange, handOverChange } = await import('../../api/evals')

const ready: AgentChange = {
  id: 'c1', kind: 'prompt', agent: 'koala', status: 'ready', why: 'It guessed in r-9.', createdAt: 'a',
  currentPrompt: 'You help the person.\nAsk before assuming.', prompt: 'You help the person.\nCheck list_infrastructure before answering about deployments.',
  comparison: { runId: 'cmp', checkedAt: 'b', scenarios: [{ scenarioId: 'koala-deploys', before: false, after: true }, { scenarioId: 'koala-chat', before: true, after: false }], better: ['koala-deploys'], worse: ['koala-chat'] },
}
const request: AgentChange = { id: 'r1', kind: 'procedure', agent: 'research', procedure: 'research', status: 'proposed', why: 'r-3 ended ok with nothing', request: 'End failed on an empty reply.', createdAt: 'b' }

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ChangesPanel /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listChanges).mockResolvedValue([ready, request, { ...request, id: 'old', status: 'handed-over' }])
})

describe('proposed changes', () => {
  it('shows a prompt change as a diff with what the bench found, before and after', async () => {
    show()

    expect(await screen.findByText('Proposed changes (2)')).toBeInTheDocument()
    expect(screen.getByText(/ready — 1 got better, 1 got worse, across 2 scenarios/)).toBeInTheDocument()
    const diff = screen.getByLabelText("What changes in koala's prompt")
    expect(diff).toHaveTextContent('− Ask before assuming.')
    expect(diff).toHaveTextContent('+ Check list_infrastructure before answering about deployments.')
    expect(screen.getByText('koala-chat: passed → fails')).toBeInTheDocument()
  })

  it('accepts the person\'s edit of a prompt change', async () => {
    vi.mocked(acceptChange).mockResolvedValue({ ...ready, status: 'accepted' })
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'Edit, then accept' }))
    const box = screen.getByRole('textbox', { name: 'The new prompt for koala' })
    await userEvent.clear(box)
    await userEvent.type(box, 'Check first.')
    await userEvent.click(screen.getByRole('button', { name: 'Accept my edit' }))

    await waitFor(() => expect(acceptChange).toHaveBeenCalledWith('c1', 'Check first.'))
  })

  it('hands a procedure request to the agent builder and opens that conversation', async () => {
    vi.mocked(handOverChange).mockResolvedValue({ ...request, status: 'handed-over', conversationId: 'conv-b' } as never)
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'Hand to the agent builder' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/chat/$conversationId', params: { conversationId: 'conv-b' } }))
  })
})
